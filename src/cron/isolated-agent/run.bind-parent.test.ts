import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createOpenClawCodingToolsAsync } from "../../agents/agent-tools.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  captureFinalEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
  type CronToolsAllowCaptureRef,
} from "../../agents/tools/cron-tool.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createOperatorRecoveryFixture } from "../../gateway/operator-run-recovery.test-support.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../../gateway/server-methods/cron-creator-authority-admission.js";
import {
  admission,
  CREATOR,
  cron as creatorCron,
  createCronFixture,
  inRun,
  installRequesterCronAuthorityTestHooks,
  SESSION,
  SESSION_ID,
  stateDir,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import { persistDevicePairingStoreState } from "../../infra/device-pairing-store.js";
import type { PairedDevice } from "../../infra/device-pairing.types.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createGatewaySchedulerClock } from "../../test-utils/gateway-scheduler-clock.js";
import { admitScheduledOccurrence } from "../execution-context-admission.js";
import { readScheduledMemoryParent } from "../execution-context-registry.js";
import { resolveScheduledPrincipal } from "../execution-context.js";
import { createAccountCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { onTimer } from "../service/timer.test-support.js";
import type { CronStoredJob } from "../types.js";
import { prepareAuthorityConfig, resetAuthorityRunHarness } from "./run.authority.test-support.js";
import { createOperatorContinuationService } from "./run.operator-continuation.test-support.js";
import {
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  patchSessionEntryMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const session = await vi.importActual<typeof import("./session.js")>("./session.js");
const accessor = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
  "../../config/sessions/session-accessor.js",
);
installRequesterCronAuthorityTestHooks();

const DEVICE: PairedDevice = {
  deviceId: "control-ui-device",
  publicKey: "fixture-public-key",
  roles: ["operator"],
  approvedScopes: ["operator.admin"],
  tokens: {
    operator: {
      token: "fixture-device-token",
      role: "operator",
      scopes: ["operator.admin"],
      createdAtMs: 1,
    },
  },
  createdAtMs: 1,
  approvedAtMs: 1,
};

const channelOwnerTurn = (runId: string): GatewayCronCreatorAuthorityAdmission => ({
  runId,
  callerOrigin: { kind: "unknown" },
  managementEntitlement: { source: "channel-owner", isCurrent: () => true },
});

const groupMemberTurn = (runId: string): GatewayCronCreatorAuthorityAdmission => ({
  runId,
  callerOrigin: { kind: "unknown" },
});

beforeEach(() => {
  resetAuthorityRunHarness();
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
});
afterEach(() => {
  runEmbeddedAgentMock.mockReset();
  vi.restoreAllMocks();
});

/**
 * Seeds a pre-#172590 shape: an account policy naming the parent by key, no incarnation.
 * Older jobs may omit agentId and run as the configured default agent.
 */
async function seedKeyOnlyJob(
  cron: ReturnType<typeof createCronFixture>["context"]["cron"],
  parentSessionKey = SESSION,
  options: { omitAgentId?: boolean; agentId?: string } = {},
) {
  const created = await cron.add(
    {
      name: "Check the deploy",
      enabled: true,
      ...(options.omitAgentId ? {} : { agentId: options.agentId ?? "main" }),
      owner: { agentId: "main", sessionKey: parentSessionKey, accountId: "default" },
      schedule: { kind: "every", everyMs: 180_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check the deploy", toolsAllow: ["read"] },
      delivery: { mode: "none" },
    },
    {
      createdActor: CREATOR,
      scheduledToolPolicy: createAccountCronScheduledToolPolicy({
        ownerSessionKey: parentSessionKey,
        ownerAccountId: "default",
      }),
    },
  );
  return "job" in created ? created.job : created;
}

/** Calls the real automations tool from a turn in the parent conversation. */
async function bindFromParent(params: {
  config: OpenClawConfig;
  context: ReturnType<typeof createCronFixture>["context"];
  runId: string;
  jobId: string;
  admitted: GatewayCronCreatorAuthorityAdmission | undefined;
  operatorAuthority?: Parameters<typeof inRun>[3];
  senderIsOwner?: boolean;
}) {
  return await inRun(
    params.runId,
    params.admitted,
    async (_identity, admitted, creator) => {
      bindGatewayContextResolver(admitted, () => params.context);
      try {
        return await withPreparedEmbeddedGatewayTools(
          {
            agentId: "main",
            sessionKey: SESSION,
            sessionId: SESSION_ID,
            agentHarnessId: "openclaw",
            admittedRunContext: admitted,
            cronCreatorAuthorityCapability: creator,
          },
          async () => {
            const capturedTools: CronCreatorToolAllowlistEntry[] = [];
            const capture: CronToolsAllowCaptureRef = {};
            const tools = await createOpenClawCodingToolsAsync({
              config: params.config,
              agentId: "main",
              sessionKey: SESSION,
              sessionId: SESSION_ID,
              workspaceDir: stateDir,
              toolConstructionPlan: {
                includeBaseCodingTools: false,
                includeShellTools: false,
                includeChannelTools: false,
                includeOpenClawTools: true,
                includePluginTools: false,
              },
              runId: params.runId,
              operationalRunInstance: admitted.operationalRunInstance,
              senderIsOwner: params.senderIsOwner ?? true,
              cronCreatorToolAllowlistRef: capturedTools,
              cronCreatorToolAllowlistCaptureRef: capture,
            });
            captureFinalEffectiveCronCreatorToolAllowlist(
              capturedTools,
              capture,
              tools,
              getPluginToolMeta,
            );
            return await expectDefined(
              tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME),
              "parent automations tool",
            ).execute("bind-parent", { action: "bind", jobId: params.jobId });
          },
        );
      } finally {
        clearGatewayContextResolver(admitted);
      }
    },
    params.operatorAuthority,
  );
}

/** Runs one occurrence and reports the parent memory the run was admitted with. */
async function runOccurrence(
  config: OpenClawConfig,
  job: CronStoredJob,
  context: never,
  expectedStatus: "ok" | "error" = "ok",
) {
  let operatorAdmitted = false;
  let memoryParent: ReturnType<typeof readScheduledMemoryParent>;
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    const admitted = await expectDefined(params.preparedRunAdmission, "scheduled admission").admit(
      "gateway",
      params.runId,
    );
    operatorAdmitted = readAdmittedRunOperatorAuthority(admitted) !== undefined;
    memoryParent = readScheduledMemoryParent(admitted.operationalRunInstance);
    return { payloads: [{ text: "Deploy checked" }], meta: { agentMeta: {} } };
  });
  const clock = createGatewaySchedulerClock(Date.now());
  const { cron: execution, state } = createOperatorContinuationService({
    config,
    stateDir,
    clock: clock.clock,
    resolveGatewayContext: () => context,
    runIsolated: runCronIsolatedAgentTurn,
    onEvent: () => {},
  });
  state.deps.admitScheduledOccurrence = ({ job: occurrenceJob }) =>
    admitScheduledOccurrence({ cfg: config, job: occurrenceJob, agentId: "main", trigger: "cron" });
  setRuntimeConfigSnapshot(config);
  try {
    await execution.start();
    clock.setTime(expectDefined(execution.getJob(job.id)?.state.nextRunAtMs, "next occurrence"));
    await onTimer(state);
    await execution.waitForIdle();
    const after = expectDefined(execution.getJob(job.id), "settled job");
    expect(after.state.lastRunStatus, after.state.lastError).toBe(expectedStatus);
    return { operatorAdmitted, memoryParent, lastError: after.state.lastError };
  } finally {
    execution.stop();
    await execution.waitForIdle();
  }
}

it.each([
  "unbound",
  "control ui owner binds",
  "control ui owner binds, then the device is revoked",
  "control ui owner binds without an agent id",
  "control ui owner binds without an agent id, then the device is revoked",
  "channel owner binds",
] as const)("a key-only automation that is %s", async (scenario) => {
  const config = await prepareAuthorityConfig({ tools: { allow: [AUTOMATIONS_TOOL_NAME] } });
  const fixture = createCronFixture(undefined, config);
  const { context } = fixture;
  context.resolveGatewayContext = () => context;
  const profile = ensureProfileForEmail("bind-operator@example.test");
  const recovery = await createOperatorRecoveryFixture({
    stateDir,
    context,
    config,
    profileId: profile.id,
    sessionKey: SESSION,
    sessionId: SESSION_ID,
    device: DEVICE,
  });
  recovery.entry.status = "done";
  recovery.entry.abortedLastRun = false;
  await accessor.replaceSessionEntry(recovery.target, recovery.entry);
  const seeded = await seedKeyOnlyJob(context.cron, SESSION, {
    omitAgentId: scenario.includes("without an agent id"),
  });
  expect(seeded.agentId).toBe(scenario.includes("without an agent id") ? undefined : "main");
  expect(resolveScheduledPrincipal(seeded, { trigger: "cron", agentId: "main" })).toEqual({
    kind: "unbound-parent",
    parentSessionKey: SESSION,
  });
  let bindResult: unknown;
  try {
    if (scenario.startsWith("control ui owner binds")) {
      const original = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: recovery.client,
          context,
          sourceAuthority: null,
        }),
        "Control UI operator authority",
      );
      try {
        bindResult = await withPluginRuntimeGatewayRequestScope(
          { client: recovery.client, context, isWebchatConnect: () => false },
          () =>
            bindFromParent({
              config,
              context,
              runId: "control-ui-binds",
              jobId: seeded.id,
              admitted: admission("control-ui-binds", recovery.client),
              operatorAuthority: original.authority,
            }),
        );
      } finally {
        original.release();
      }
    } else if (scenario === "channel owner binds") {
      bindResult = await bindFromParent({
        config,
        context,
        runId: "channel-owner-binds",
        jobId: seeded.id,
        admitted: channelOwnerTurn("channel-owner-binds"),
      });
    }
  } finally {
    context.cron.stop();
    await creatorCron.waitForIdle();
  }
  const job = expectDefined(
    (await fixture.read()).find((entry) => entry.id === seeded.id),
    "stored automation",
  );
  // Binding never rewrites the job's requester attribution, agent, or tool policy.
  expect(job.createdActor).toEqual(CREATOR);
  expect(job.agentId).toBe(seeded.agentId);
  expect(job.scheduledToolPolicy).toEqual(seeded.scheduledToolPolicy);
  if (scenario === "unbound") {
    expect(job.sourceConversation).toBeUndefined();
  } else {
    expect(job.sourceConversation).toEqual({
      sessionKey: SESSION,
      sessionId: SESSION_ID,
      lifecycleRevision: recovery.entry.lifecycleRevision,
    });
  }
  if (scenario.startsWith("control ui owner binds")) {
    expect(job.operatorSource?.source).toMatchObject({
      agentId: "main",
      sessionKey: SESSION,
      sessionId: SESSION_ID,
      snapshot: { profileId: profile.id, device: { deviceId: DEVICE.deviceId } },
    });
  } else {
    expect(job.operatorSource).toBeUndefined();
  }
  if (scenario !== "unbound") {
    // The reply describes the stored job, not what the turn captured.
    expect(bindResult).toMatchObject({
      details: { bound: { operatorSource: job.operatorSource !== undefined } },
    });
  }

  if (scenario.endsWith("then the device is revoked")) {
    persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, stateDir, "both");
    // The bound occurrence rechecks the stored operator source and refuses before any effect.
    const refused = await runOccurrence(config, job, context as never, "error");
    expect(refused.lastError).toMatch(
      /operator authority that created this automation was refused/,
    );
    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    return;
  }
  const occurrence = await runOccurrence(config, job, context as never);
  if (scenario === "unbound") {
    // Unbound jobs keep the run-session decisions: no parent memory, no operator source.
    expect(occurrence.memoryParent).toBeUndefined();
    expect(occurrence.operatorAdmitted).toBe(false);
  } else if (scenario.startsWith("control ui owner binds")) {
    expect(occurrence.operatorAdmitted).toBe(true);
    expect(occurrence.memoryParent).toMatchObject({ sessionKey: SESSION, senderIsOwner: true });
  } else {
    // The stored profile requester still decides owner status; the fixture's
    // attributed profile is not resident, so the bound child is not the owner.
    expect(occurrence.operatorAdmitted).toBe(false);
    expect(occurrence.memoryParent).toMatchObject({ sessionKey: SESSION, senderIsOwner: false });
  }
});

it.each([
  "a group member turn",
  "an owner turn without the management grant",
  "another conversation's job",
  "a job that runs as another agent",
  "an already bound job",
  "a trusted operator job",
] as const)("refuses bind from %s and leaves the job unchanged", async (scenario) => {
  const config = await prepareAuthorityConfig({ tools: { allow: [AUTOMATIONS_TOOL_NAME] } });
  const fixture = createCronFixture(undefined, config);
  const { context } = fixture;
  context.resolveGatewayContext = () => context;
  const job =
    scenario === "another conversation's job"
      ? await seedKeyOnlyJob(context.cron, "agent:main:telegram:group:other")
      : scenario === "a job that runs as another agent"
        ? await seedKeyOnlyJob(context.cron, SESSION, { agentId: "worker" })
        : scenario === "a trusted operator job"
          ? await context.cron.add(
              {
                name: "Operator job",
                enabled: true,
                agentId: "main",
                owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
                schedule: { kind: "every", everyMs: 180_000 },
                sessionTarget: "isolated",
                wakeMode: "now",
                payload: { kind: "agentTurn", message: "Check", toolsAllow: ["read"] },
                delivery: { mode: "none" },
              },
              { scheduledToolPolicy: { version: 1, mode: "trusted" } },
            )
          : await seedKeyOnlyJob(context.cron);
  const jobId = "job" in job ? job.job.id : job.id;
  if (scenario === "an already bound job") {
    await context.cron.update(
      jobId,
      {},
      {
        bindSourceConversation: {
          sessionKey: SESSION,
          sessionId: "earlier-incarnation",
          lifecycleRevision: "earlier",
        },
      },
    );
  }
  const before = (await fixture.read()).find((entry) => entry.id === jobId);
  try {
    const bind = bindFromParent({
      config,
      context,
      runId: "refused-bind",
      jobId,
      admitted:
        scenario === "a group member turn" ||
        scenario === "an owner turn without the management grant"
          ? groupMemberTurn("refused-bind")
          : channelOwnerTurn("refused-bind"),
      senderIsOwner: scenario !== "a group member turn",
    });
    if (scenario === "a group member turn") {
      // A non-owner sender in the parent conversation never reaches the automations tool.
      await expect(bind).resolves.toMatchObject({ details: { gated: true } });
    } else {
      await expect(bind).rejects.toThrow(
        scenario === "an owner turn without the management grant"
          ? /authenticated owner turn/
          : scenario === "another conversation's job"
            ? /not its parent/
            : scenario === "a job that runs as another agent"
              ? /different agent/
              : scenario === "an already bound job"
                ? /already bound/
                : /session key alone/,
      );
    }
  } finally {
    context.cron.stop();
    await creatorCron.waitForIdle();
  }
  expect((await fixture.read()).find((entry) => entry.id === jobId)).toEqual(before);
});

it("refuses the stored write when the owner loses authority while bind waits for the store", async () => {
  const config = await prepareAuthorityConfig({ tools: { allow: [AUTOMATIONS_TOOL_NAME] } });
  const fixture = createCronFixture(undefined, config);
  const { context } = fixture;
  context.resolveGatewayContext = () => context;
  const seeded = await seedKeyOnlyJob(context.cron);
  const before = (await fixture.read()).find((entry) => entry.id === seeded.id);
  let ownerCurrent = true;
  const update = context.cron.updateWithPrecondition.bind(context.cron);
  // Revoke between the handler's checks and the commit under the cron lock.
  const commit = vi
    .spyOn(context.cron, "updateWithPrecondition")
    .mockImplementation(async (...args) => {
      ownerCurrent = false;
      return await update(...args);
    });
  try {
    await expect(
      bindFromParent({
        config,
        context,
        runId: "revoked-bind",
        jobId: seeded.id,
        admitted: {
          runId: "revoked-bind",
          callerOrigin: { kind: "unknown" },
          managementEntitlement: { source: "channel-owner", isCurrent: () => ownerCurrent },
        },
      }),
    ).rejects.toThrow(/admin grant is missing, expired, or already used/);
  } finally {
    context.cron.stop();
    await creatorCron.waitForIdle();
  }
  expect(commit).toHaveBeenCalledTimes(1);
  expect((await fixture.read()).find((entry) => entry.id === seeded.id)).toEqual(before);
});
