import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { admitScheduledOccurrence } from "../../../cron/execution-context-admission.js";
import { captureCronInferenceBinding } from "../../../cron/inference-binding.runtime.js";
import { runCronIsolatedAgentTurn } from "../../../cron/isolated-agent/run.js";
import { CronService } from "../../../cron/service.js";
import { createNoopLogger } from "../../../cron/service.test-harness.js";
import { resolveCronOperatorExecutionRevision } from "../../../cron/service/jobs-tool-policy.js";
import { runCronSessionTurn } from "../../../cron/session-run.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
} from "../../../gateway/operator-run-recovery.test-support.js";
import { createScheduledGatewayRunner } from "../../../gateway/scheduled-run-gateway-context.js";
import { setCanonicalUserProfileRole } from "../../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../../test-utils/gateway-scheduler-clock.js";
import { captureScheduledOperatorSource } from "../../operator-run-recovery-source.js";
import type { NativePluginSpawnTestOptions } from "./subagent-spawn.production-boundary.test-support.js";

type CronAccessProofOptions = NativePluginSpawnTestOptions & { parentSessionKey: string };

export async function runCronAccessLifecycle({
  adapter,
  outcome,
  program,
  modelId,
  bound,
  context,
  options,
  writes,
}: {
  adapter: "cron" | "cron-session";
  outcome: "allowed" | "unavailable" | "revoked" | "reassigned" | "role-denied";
  program: "standard" | "daybreak_blue" | "daybreak_red";
  modelId: string;
  bound: Awaited<ReturnType<CronAccessProofOptions["createBoundParent"]>>;
  context: Awaited<ReturnType<CronAccessProofOptions["createBoundGateway"]>>["context"];
  options: CronAccessProofOptions;
  writes: unknown[];
}) {
  let cronResult: Awaited<ReturnType<typeof runCronSessionTurn>> | undefined;
  bound.cfg.gateway = {
    ...bound.cfg.gateway,
    roles: {
      default: "runner",
      definitions: {
        runner: {
          scopes: ["operator.admin"],
          agents: "*",
          sessions: { others: "none" },
          accessPrograms: { cyber: ["daybreak_blue"] },
        },
      },
    },
  };
  const profile = ensureProfileForEmail("cron-access@example.test");
  await setCanonicalUserProfileRole(profile.id, "runner");
  const recovery = await createOperatorRecoveryFixture({
    stateDir: bound.cfg.agents!.defaults!.workspace!,
    context,
    config: bound.cfg,
    profileId: profile.id,
    device: pairedOperator(),
  });
  await upsertSessionEntryCore(
    { storePath: bound.storePath, sessionKey: options.parentSessionKey },
    { createdActor: { type: "human", source: "profile", id: profile.id } },
  );
  const restored = await recovery.restore();
  const operatorSource = captureScheduledOperatorSource({
    authority: restored.authority,
    agentId: "main",
    independent: true,
    sourceRunId: "cron-access-source",
  });
  restored.release();

  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    runSchedulerOwned: createScheduledGatewayRunner(context.resolveGatewayContext),
    storePath: path.join(bound.cfg.agents!.defaults!.workspace!, "cron", "access-proof.json"),
    cronEnabled: false,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: () => {},
    admitScheduledOccurrence: ({ job }) =>
      admitScheduledOccurrence({ cfg: bound.cfg, job, agentId: "main", trigger: "cron" }),
    runSessionEvent: async (request) => {
      cronResult = await runCronSessionTurn({
        ...request,
        cfg: bound.cfg,
        agentId: "main",
        sessionKey: options.parentSessionKey,
      });
      return cronResult;
    },
    runIsolatedAgentJob: (request) =>
      runCronIsolatedAgentTurn({
        ...request,
        cfg: bound.cfg,
        deps: {},
        agentId: "main",
        sessionKey: `cron:${request.job.id}`,
      }),
  });
  onTestFinished(async () => {
    cron.stop();
    await cron.waitForIdle();
  });
  const binding = await captureCronInferenceBinding({
    cfg: bound.cfg,
    agentId: "main",
    model: `openai/${modelId}@openai:default`,
  });
  const job = await cron.add(
    {
      name: "Access boundary proof",
      enabled: false,
      schedule: { kind: "every", everyMs: 60000 },
      sessionTarget:
        adapter === "cron-session" ? `session:${options.parentSessionKey}` : "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "bounded review",
        model: `openai/${modelId}`,
      },
      delivery: { mode: "none" },
      cyberAccessProgram: program,
    },
    { inferenceBinding: binding, operatorSource },
  );
  context.cron = cron;
  if (adapter === "cron-session") {
    bound.admission.close();
    bound.parent.cleanup();
  }
  if (outcome === "role-denied") {
    bound.cfg.gateway.roles!.definitions.runner!.accessPrograms = { cyber: [] };
    setRuntimeConfigSnapshot(bound.cfg);
  }
  expect(await cron.run(job.id, "force")).toMatchObject({ ok: true, ran: true });
  if (outcome === "role-denied" && options.runEmbeddedAgent.mock.calls.length === 0) {
    expect(cron.getJob(job.id)?.state.lastError).toMatch(/Access|allowed|role/i);
    expect(writes).toHaveLength(0);
    return { skipped: true as const };
  }
  if (adapter === "cron") {
    expect(options.runEmbeddedAgent).toHaveBeenCalled();
  }
  if (outcome === "allowed") {
    expect(await cron.run(job.id, "force")).toMatchObject({ ok: true, ran: true });
    await cron.update(
      job.id,
      { cyberAccessProgram: "standard" },
      {
        operatorSource,
        operatorSourceExecutionRevision: resolveCronOperatorExecutionRevision({
          ...expectDefined(cron.getJob(job.id), "current job"),
          cyberAccessProgram: "standard",
        }),
      },
    );
    expect(await cron.run(job.id, "force")).toMatchObject({ ok: true, ran: true });
    expect(writes).toHaveLength(3);
    expect(writes[1]).toMatchObject({ access_programs: { cyber: program } });
    expect(writes[2]).toMatchObject({ access_programs: { cyber: "standard" } });
    await cron.remove(job.id);
    expect(cron.getJob(job.id)).toBeUndefined();
    await expect(cron.run(job.id, "force")).rejects.toThrow("unknown cron job id");
    expect(writes).toHaveLength(3);
    console.log(
      JSON.stringify({
        adapter,
        lifecycle: "repeated fire, update Standard, delete",
        finalAccess: [program, program, "standard"],
        requests: writes.length,
      }),
    );
  }

  return { skipped: false as const, result: cronResult };
}
