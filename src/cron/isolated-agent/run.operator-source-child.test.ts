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
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { invalidateGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createOperatorRecoveryFixture } from "../../gateway/operator-run-recovery.test-support.js";
import {
  admission,
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
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createGatewaySchedulerClock } from "../../test-utils/gateway-scheduler-clock.js";
import { admitScheduledOccurrence } from "../execution-context-admission.js";
import { readScheduledMemoryParent } from "../execution-context-registry.js";
import type { CronEvent } from "../service.js";
import { onTimer } from "../service/timer.test-support.js";
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

// A Control UI turn creates a detached child job; each occurrence rechecks the
// creator's device and role grant through the stored operator source.
it.each([
  "valid",
  "device revoked",
  "role revoked",
  "parent reset",
  "parent reset then device revoked",
  "device revoked during the run",
  "no operator source",
] as const)("a Control UI child automation with %s", async (scenario) => {
  const config = await prepareAuthorityConfig({ tools: { allow: [AUTOMATIONS_TOOL_NAME] } });
  const fixture = createCronFixture(undefined, config);
  const { context } = fixture;
  const resolveGatewayContext = () => context;
  context.resolveGatewayContext = resolveGatewayContext;
  const profile = ensureProfileForEmail("child-operator@example.test");
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
  // Without operator admission the creating turn stores only its profile attribution.
  const original =
    scenario === "no operator source"
      ? undefined
      : expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: recovery.client,
            context,
            sourceAuthority: null,
          }),
          "Control UI operator authority",
        );
  const clock = createGatewaySchedulerClock(Date.now());
  const toolDefaults = {
    config,
    agentId: "main",
    sessionKey: SESSION,
    sessionId: SESSION_ID,
    workspaceDir: stateDir,
  };
  const toolConstructionPlan = {
    includeBaseCodingTools: false,
    includeShellTools: false,
    includeChannelTools: false,
    includeOpenClawTools: true,
    includePluginTools: false,
  };
  const create = () =>
    inRun(
      "control-ui-creates-child",
      original ? admission("control-ui-creates-child", recovery.client) : undefined,
      async (_identity, admitted, creator) => {
        bindGatewayContextResolver(admitted, () => context);
        try {
          await withPreparedEmbeddedGatewayTools(
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
                ...toolDefaults,
                toolConstructionPlan: { ...toolConstructionPlan },
                runId: "control-ui-creates-child",
                operationalRunInstance: admitted.operationalRunInstance,
                senderIsOwner: true,
                cronCreatorToolAllowlistRef: capturedTools,
                cronCreatorToolAllowlistCaptureRef: capture,
              });
              captureFinalEffectiveCronCreatorToolAllowlist(
                capturedTools,
                capture,
                tools,
                getPluginToolMeta,
              );
              await expectDefined(
                tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME),
                "creator automations",
              ).execute("schedule-child", {
                action: "add",
                job: {
                  name: "Check the deploy",
                  schedule: { kind: "every", everyMs: 180_000 },
                  sessionTarget: "current",
                  payload: { kind: "agentTurn", message: "Check the deploy" },
                  delivery: { mode: "none" },
                },
              });
            },
          );
        } finally {
          clearGatewayContextResolver(admitted);
        }
      },
      original?.authority,
    );
  try {
    if (original) {
      await withPluginRuntimeGatewayRequestScope(
        { client: recovery.client, context, isWebchatConnect: () => false },
        create,
      );
    } else {
      await create();
    }
  } finally {
    original?.release();
    fixture.context.cron.stop();
    await creatorCron.waitForIdle();
  }
  const job = expectDefined((await fixture.read())[0], "stored child automation");
  expect(job.sessionTarget).toBe("current");
  expect(job.sourceConversation).toMatchObject({ sessionKey: SESSION, sessionId: SESSION_ID });
  if (scenario === "no operator source") {
    expect(job.operatorSource).toBeUndefined();
  } else {
    expect(job.operatorSource?.source).toMatchObject({
      agentId: "main",
      sessionKey: SESSION,
      sessionId: SESSION_ID,
      snapshot: { profileId: profile.id, device: { deviceId: DEVICE.deviceId } },
    });
  }

  if (scenario === "device revoked" || scenario === "parent reset then device revoked") {
    persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, stateDir, "both");
  } else if (scenario === "role revoked") {
    await setCanonicalUserProfileRole(profile.id, "blocked");
  }
  if (scenario.startsWith("parent reset")) {
    await replaceSessionEntry(recovery.target, {
      ...recovery.entry,
      sessionId: "reset-session",
      lifecycleRevision: "reset",
    });
  }

  let entered = 0;
  let operatorAdmitted = false;
  let revokedDuringRun: boolean | undefined;
  let memoryParent: ReturnType<typeof readScheduledMemoryParent>;
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    entered++;
    const admitted = await expectDefined(params.preparedRunAdmission, "scheduled admission").admit(
      "gateway",
      params.runId,
    );
    const operator = readAdmittedRunOperatorAuthority(admitted);
    operatorAdmitted = operator !== undefined;
    if (scenario === "device revoked during the run") {
      // The Gateway's device-token revocation owner fences every capture of that device.
      invalidateGatewayDeviceRevocation(context, DEVICE.deviceId, "operator");
      revokedDuringRun = (() => {
        try {
          operator?.assertCurrent();
          return false;
        } catch {
          return true;
        }
      })();
    }
    memoryParent = readScheduledMemoryParent(admitted.operationalRunInstance);
    return { payloads: [{ text: "Deploy checked" }], meta: { agentMeta: {} } };
  });
  const finished = vi.fn<(event: CronEvent) => void>();
  const { cron: execution, state } = createOperatorContinuationService({
    config,
    stateDir,
    clock: clock.clock,
    resolveGatewayContext,
    runIsolated: runCronIsolatedAgentTurn,
    onEvent: (event) => {
      if (event.action === "finished" && event.jobId === job.id) {
        finished(event);
      }
    },
  });
  // Production wires the occurrence owner; the shared fixture leaves it to each test.
  state.deps.admitScheduledOccurrence = ({ job: occurrenceJob }) =>
    admitScheduledOccurrence({ cfg: config, job: occurrenceJob, agentId: "main", trigger: "cron" });
  context.cron = execution;
  setRuntimeConfigSnapshot(config);
  try {
    await execution.start();
    clock.setTime(expectDefined(execution.getJob(job.id)?.state.nextRunAtMs, "next occurrence"));
    await onTimer(state);
    await execution.waitForIdle();
    const after = expectDefined(execution.getJob(job.id), "settled job");
    if (scenario === "device revoked during the run") {
      expect(entered).toBe(1);
      expect(operatorAdmitted).toBe(true);
      expect(revokedDuringRun).toBe(true);
      return;
    }
    if (scenario === "valid" || scenario === "no operator source" || scenario === "parent reset") {
      expect(after.state.lastRunStatus, after.state.lastError).toBe("ok");
      expect(after.enabled).toBe(true);
      expect(entered).toBe(1);
      expect(operatorAdmitted).toBe(scenario !== "no operator source");
      if (scenario === "parent reset") {
        // A reset parent runs unbound: nothing carries into the new incarnation.
        expect(memoryParent).toBeUndefined();
      } else if (scenario === "valid") {
        expect(memoryParent).toMatchObject({ sessionKey: SESSION, senderIsOwner: true });
      } else {
        // Without a snapshot the existing profile check decides owner status; the
        // fixture's attributed profile is not resident, so it is not the owner.
        expect(job.createdActor).toMatchObject({ source: "profile", id: "fixture-operator" });
        expect(memoryParent).toMatchObject({ sessionKey: SESSION, senderIsOwner: false });
      }
      return;
    }
    expect(entered).toBe(0);
    expect(after.state.lastRunStatus).toBe("error");
    expect(after.state.lastError).toMatch(
      /operator authority that created this automation was refused/,
    );
    expect(after.state.lastError).toMatch(
      scenario === "role revoked" ? /operator identity changed/i : /authority|policy/i,
    );
    // The refused source cannot recover through retries, so the job stops.
    expect(after.enabled).toBe(false);
    expect(after.state.nextRunAtMs).toBeUndefined();
  } finally {
    execution.stop();
    await execution.waitForIdle();
  }
});
