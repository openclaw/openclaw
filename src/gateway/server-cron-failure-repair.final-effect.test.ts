import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { openEventToolHost } from "../auto-reply/reply/session-event.test-support.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCronOperatorExecutionRevision } from "../cron/service/jobs-tool-policy.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
} from "./operator-run-recovery.test-support.js";
import { createGatewayCronFailureRepair } from "./server-cron-notifications.js";
import {
  cfg,
  createCronFixture,
  installRequesterCronAuthorityTestHooks,
  SESSION,
  SESSION_ID,
  stateDir,
} from "./server-methods/requester-cron-authority.test-support.js";

// mock-isolation: Synthetic model only; dispatch, admission, tool gates and cron handlers are real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
installRequesterCronAuthorityTestHooks();

// The stored job after its repair turn tried `automations update`, by the job's requester.
const outcomes = {
  owner: { update: "ok", description: "fixed by repair" },
  "non-owner": { update: "gated", description: "original" },
  // Revoked after the repair was queued: admission refuses the turn before any tool runs;
  // the job's next failure alert owns escalation.
  "revoked-while-queued": { update: "not run", description: "original" },
  // Revoking publishes config, which retires the admitted turn's tool host before the write.
  "revoked-after-admission": {
    update: "agent harness host capability is no longer active",
    description: "original",
  },
} as const;

it.for(Object.keys(outcomes) as Array<keyof typeof outcomes>)(
  "persists a failure repair's job update only for a current owner requester: %s",
  async (requester) => {
    const config = {
      ...cfg,
      plugins: { enabled: false },
      channels: { telegram: {} },
      commands: { ownerAllowFrom: ["456"] },
    } as OpenClawConfig;
    const revoke = () =>
      setRuntimeConfigSnapshot({ ...config, commands: { ownerAllowFrom: ["789"] } });
    setRuntimeConfigSnapshot(config);
    const { context, read } = createCronFixture(undefined, config);
    // The Gateway reads its current published config, as in production.
    context.getRuntimeConfig = () => getRuntimeConfigSnapshot()!;
    const job = await context.cron.add(
      {
        name: "Health check",
        description: "original",
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check the dashboard.", toolsAllow: ["read"] },
        delivery: { mode: "none" },
        owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
      },
      {
        // What a channel owner's turn stores when it creates the job.
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: SESSION,
          ownerAccountId: "default",
        },
        toolsAllowProvenance: {
          version: 1,
          source: "final-executable-surface",
          callerOrigin: { kind: "unknown" },
          channelRequester: {
            version: 1,
            channel: "telegram",
            accountId: "default",
            senderId: requester === "non-owner" ? "789" : "456",
          },
        },
      },
    );

    expect(context.cron.getJob(job.id)?.toolsAllowProvenance?.channelRequester).toBeDefined();
    let update = "not run";
    runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
      const admission = params.preparedRunAdmission!;
      const admit = admission.admit.bind(admission);
      // The turn's tools reach this Gateway's real cron handlers in process.
      const admitted = Object.assign(Object.create(Object.getPrototypeOf(admission)), admission, {
        admit: async (...args: Parameters<typeof admit>) => {
          if (requester === "revoked-while-queued") {
            revoke();
          }
          const run = await admit(...args);
          bindGatewayContextResolver(run, () => context);
          return run;
        },
      });
      const { tools, close } = await openEventToolHost(
        { ...params, preparedRunAdmission: admitted },
        "repair admission",
        { includeOpenClawTools: true },
      );
      if (requester === "revoked-after-admission") {
        revoke();
      }
      update = await tools
        .find((tool) => tool.name === "automations")!
        .execute("repair-update", {
          action: "update",
          jobId: job.id,
          job: { description: "fixed by repair" },
        })
        .then(
          (result) => ((result.details as { gated?: boolean } | undefined)?.gated ? "gated" : "ok"),
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        .finally(close);
      return { payloads: [{ text: "Repaired." }], meta: { durationMs: 1 } };
    });

    const repaired = createGatewayCronFailureRepair(config, () => context).runCronFailureRepair({
      jobId: job.id,
      repairId: `repair-${requester}`,
      timeoutMs: 60_000,
      agentId: "main",
      sessionKey: SESSION,
      message: "Automation repair request from the scheduler, not a user message.",
    });
    if (requester === "revoked-while-queued") {
      await expect(repaired).rejects.toThrow("Cron failure repair did not run");
    } else {
      await repaired;
    }

    const stored = (await read()).find((candidate) => candidate.id === job.id);
    expect({ update, description: stored?.description }).toEqual(outcomes[requester]);
  },
);

// An operator-source job (created from a Control UI turn) repaired in its source conversation.
const operatorOutcomes = {
  // A Control UI administrator's restored source keeps owner tools, as its in-session runs do.
  "control-ui-admin": { update: "ok", description: "fixed by repair" },
  // A restored source that was not a Control UI administrator is a non-owner requester.
  "non-admin-source": { update: "gated", description: "original" },
  // A refused restore is still this job's requester: no owner tools, no session fallback.
  "device-revoked": { update: "gated", description: "original" },
  // The Gateway's device revocation fences the retained source before the turn starts.
  "device-revoked-while-queued": { update: "not run", description: "original" },
} as const;

it.for(Object.keys(operatorOutcomes) as Array<keyof typeof operatorOutcomes>)(
  "persists an operator-source repair's job update only while its source stays current: %s",
  async (scenario) => {
    const config = { ...cfg, plugins: { enabled: false } } as OpenClawConfig;
    setRuntimeConfigSnapshot(config);
    const { context, read } = createCronFixture(undefined, config);
    const recovery = await createOperatorRecoveryFixture({
      stateDir,
      context,
      config,
      profileId: ensureProfileForEmail("repair-operator@example.test").id,
      sessionKey: SESSION,
      sessionId: SESSION_ID,
      device: pairedOperator(),
      ...(scenario === "non-admin-source" ? { scopes: ["operator.read", "operator.write"] } : {}),
    });
    context.getRuntimeConfig = () => getRuntimeConfigSnapshot()!;
    const job = await context.cron.add(
      {
        name: "Health check",
        description: "original",
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "Check the dashboard.", toolsAllow: ["read"] },
        delivery: { mode: "none" },
        owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
      },
      {
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: SESSION,
          ownerAccountId: "default",
        },
        sourceConversation: { sessionKey: SESSION, sessionId: SESSION_ID },
      },
    );
    // Bind the creating turn's source to this exact definition, as the cron handler does.
    await context.cron.update(
      job.id,
      {},
      {
        operatorSource: {
          version: 1,
          agentId: "main",
          sessionKey: SESSION,
          sessionId: SESSION_ID,
          lifecycleRevision: recovery.entry.lifecycleRevision,
          sourceRunId: "control-ui-created-job",
          snapshot: recovery.snapshot,
        },
        operatorSourceExecutionRevision: resolveCronOperatorExecutionRevision(
          context.cron.getJob(job.id)!,
        ),
      },
    );
    expect(context.cron.getJob(job.id)?.operatorSource).toBeDefined();
    if (scenario === "device-revoked") {
      persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, stateDir, "both");
    }

    let update = "not run";
    runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
      const admission = params.preparedRunAdmission!;
      const admit = admission.admit.bind(admission);
      const admitted = Object.assign(Object.create(Object.getPrototypeOf(admission)), admission, {
        admit: async (...args: Parameters<typeof admit>) => {
          if (scenario === "device-revoked-while-queued") {
            invalidateGatewayDeviceRevocation(context, pairedOperator().deviceId, "operator");
          }
          const run = await admit(...args);
          bindGatewayContextResolver(run, () => context);
          return run;
        },
      });
      const { tools, close } = await openEventToolHost(
        { ...params, preparedRunAdmission: admitted },
        "operator repair admission",
        { includeOpenClawTools: true },
      );
      update = await tools
        .find((tool) => tool.name === "automations")!
        .execute("operator-repair-update", {
          action: "update",
          jobId: job.id,
          job: { description: "fixed by repair" },
        })
        .then(
          (result) => ((result.details as { gated?: boolean } | undefined)?.gated ? "gated" : "ok"),
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )
        .finally(close);
      return { payloads: [{ text: "Repaired." }], meta: { durationMs: 1 } };
    });

    const repaired = createGatewayCronFailureRepair(config, () => context).runCronFailureRepair({
      jobId: job.id,
      repairId: `operator-repair-${scenario}`,
      timeoutMs: 60_000,
      agentId: "main",
      sessionKey: SESSION,
      message: "Automation repair request from the scheduler, not a user message.",
    });
    if (scenario === "device-revoked-while-queued") {
      await expect(repaired).rejects.toThrow("Cron failure repair did not run");
    } else {
      await repaired;
    }

    const stored = (await read()).find((candidate) => candidate.id === job.id);
    expect({ update, description: stored?.description }).toEqual(operatorOutcomes[scenario]);
  },
);
