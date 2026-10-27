import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { createApiKeyCredential } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { admitTestReplyTurn } from "../auto-reply/reply/reply-turn-admission.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CronService } from "../cron/service.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import { loadCronStore } from "../cron/store.js";
import {
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createOwnershipRecord } from "../plugins/registry-ownership.test-support.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "./agent-runtime-approval-authority.js";
import type { createAgentTurnService } from "./agent-turn/agent-turn-service.js";
import { registerChatAbortController } from "./chat-abort.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "./server-methods/cron-creator-authority-admission.js";
import {
  inRun,
  SESSION,
  SESSION_ID,
  createCreatorTransportTools,
  type RequesterRun,
} from "./server-methods/requester-cron-authority.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

const startTurn = vi.hoisted(() => vi.fn<ReturnType<typeof createAgentTurnService>["startTurn"]>());

// mock-isolation: Model preparation is unrelated to restored authority and the real automation write.
vi.mock("./agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));
// mock-isolation: Skip the provider; the admitted turn invokes the production automation tool and Gateway commit owner.
vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

afterEach(() => {
  startTurn.mockReset();
  vi.restoreAllMocks();
  resetAgentEventsForTest();
  resetGlobalHookRunner();
  resetTestPluginRegistry();
});

function createRecoveryRuntime(context: ReturnType<typeof createDirectChatContext>) {
  const runtime = createGatewayInstanceRuntime({
    getContext: () => context,
    getMethodRegistry: () => createRequestGatewayMethodRegistry(),
    isDispatchAvailable: () => true,
  });
  return Object.assign(runtime, { [Symbol.dispose]: runtime.close });
}

async function coldRestart(stateDir: string) {
  await cleanupSessionStateForTest({ stateDir });
  rotateAgentEventLifecycleGeneration();
}

function recover(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  stateDir: string,
  runtime: ReturnType<typeof createRecoveryRuntime>,
  cfg: OpenClawConfig = {},
) {
  return recoverStore({
    storeAgentId: "main",
    storePath: fixture.target.storePath,
    stateDir,
    cfg,
    handledSessionKeys: new Set(),
    gatewayRuntime: runtime.recovery,
  });
}

function interSession(
  sourceTool: "sessions_send" | "subagent_settle",
  sourceSessionKey: string,
  sourceChannel = "internal",
): InputProvenance {
  return { kind: "inter_session", sourceTool, sourceSessionKey, sourceChannel };
}

async function appendInterruptedTurn(
  target: Parameters<typeof appendTranscriptMessage>[0],
  options: { cwd?: string; provenance?: InputProvenance; steering?: boolean } = {},
) {
  for (const message of [
    {
      role: "user",
      content: "Continue the accepted task",
      timestamp: 1,
      provenance: options.provenance,
    },
    ...(options.steering ? [{ role: "user", content: "Also check its result", timestamp: 2 }] : []),
    { role: "assistant", content: [], stopReason: "aborted", timestamp: options.steering ? 3 : 2 },
  ]) {
    await appendTranscriptMessage(target, { cwd: options.cwd, message });
  }
}

const settledRecovery = { started: 0, settled: 1, failed: 0, skipped: 0 };

describe("cold restart recovery of native operator input", () => {
  it("retires stale operator recovery once and admits new messages to the rotated session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const context = createDirectChatContext({ trackExecution: trackAsyncWork });
      const profile = ensureProfileForEmail("stale-recovery@example.test");
      const fixture = await recoveryFixture(state.stateDir, profile.id, {
        context,
      });
      const target = { ...fixture.target, sessionId: "rotated-session" };
      await replaceSessionEntry(target, {
        ...fixture.entry,
        sessionId: target.sessionId,
        status: "failed",
        abortedLastRun: true,
        lifecycleRunId: target.sourceRunId,
        mainRestartRecovery: { cycleId: "failed-recovery", revision: 1, chargedAttempts: 1 },
        restartRecoveryRuns: [{ runId: target.sourceRunId, lifecycleGeneration: "before-restart" }],
      });
      await appendInterruptedTurn(target);
      const originalTranscript = await loadTranscriptEvents(target);
      await coldRestart(state.stateDir);
      using runtime = createRecoveryRuntime(context);
      context.recoveryRuntime = runtime.recovery;
      const admit = () =>
        admitTestReplyTurn({
          ...target,
          expectedSessionId: target.sessionId,
          resolveGatewayContext: () => context,
        });
      const next = await admit();
      expect(next.status).toBe("owned");
      if (next.status === "owned") {
        next.operation.complete();
      }
      const entry = await readSessionEntryReadOnlyInWorker(target);
      expect(entry).toMatchObject({ sessionId: target.sessionId, abortedLastRun: false });
      expect(entry?.mainRestartRecovery).toBeUndefined();
      expect(entry?.restartRecoveryOperatorSource).toBeUndefined();
      expect(entry?.restartRecoveryTerminalRunIds).toContain(target.sourceRunId);
      const transcript = await loadTranscriptEvents(target);
      expect(transcript).toHaveLength(originalTranscript.length + 1);
      expect(transcript.slice(0, originalTranscript.length)).toEqual(originalTranscript);
      expect(JSON.stringify(transcript)).toContain(
        "Restart recovery operator source no longer owns this input",
      );
      expect(JSON.stringify(transcript)).toContain("Send a new authenticated message to continue.");
      const later = await admit();
      expect(later.status).toBe("owned");
      if (later.status === "owned") {
        later.operation.complete();
      }
      expect(await loadTranscriptEvents(target)).toEqual(transcript);
      expect(startTurn).not.toHaveBeenCalled();
    });
  });

  it.each([
    "write operator",
    "trusted proxy",
    "revoked operator",
    "revoked operator with saved final",
  ] as const)(
    "settles one interrupted turn for %s without broadening its authority",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setRuntimeConfigSnapshot({});
        const context = createDirectChatContext({ trackExecution: trackAsyncWork });
        const profile = ensureProfileForEmail("session-recovery@example.test");
        const revoked = scenario.startsWith("revoked");
        const pendingFinalDelivery =
          scenario === "revoked operator with saved final"
            ? { kind: "replayable" as const, text: "Saved interrupted response", createdAt: 1 }
            : undefined;
        const scopes = [
          scenario === "write operator" ? "operator.write" : "operator.sessions.write",
        ];
        const fixture = await recoveryFixture(state.stateDir, profile.id, {
          context,
          scopes,
          tokenlessDevice: scenario === "trusted proxy",
        });
        await replaceSessionEntry(fixture.target, {
          ...fixture.entry,
          status: "interrupted",
          lifecycleRunId: fixture.target.sourceRunId,
          pendingFinalDelivery,
        });
        await appendInterruptedTurn(fixture.target);
        await coldRestart(state.stateDir);
        if (revoked) {
          setUserProfileRole(profile.id, "revoked-role");
        }
        using runtime = createRecoveryRuntime(context);
        startTurn.mockImplementation(async ({ principal, io, preflight }) => {
          expect(principal?.internal?.operatorRunAuthority?.scopes).toEqual(scopes);
          io.emitAcceptance([
            true,
            { runId: preflight.request.idempotencyKey, status: "ok" },
            undefined,
          ]);
        });
        await markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir, cfg: {} });
        expect(await recover(fixture, state.stateDir, runtime)).toEqual(settledRecovery);
        const settledTranscript = await loadTranscriptEvents(fixture.target);
        await recover(fixture, state.stateDir, runtime);
        expect(await loadTranscriptEvents(fixture.target)).toEqual(settledTranscript);
        expect(startTurn).toHaveBeenCalledTimes(revoked ? 0 : 1);
        if (pendingFinalDelivery) {
          const entry = await readSessionEntryReadOnlyInWorker(fixture.target);
          expect(entry?.mainRestartRecovery?.tombstone?.reason).toContain("operator");
          expect(entry?.pendingFinalDelivery).toEqual(pendingFinalDelivery);
          expect(entry?.status).toBe("failed");
          expect(JSON.stringify(settledTranscript)).toContain("I couldn't continue this session");
        } else if (revoked) {
          const entry = await readSessionEntryReadOnlyInWorker(fixture.target);
          expect(entry?.lastRunError).toContain("operator");
          expect(entry?.mainRestartRecovery).toBeUndefined();
          expect(entry?.status).toBe("interrupted");
          expect(JSON.stringify(settledTranscript)).toContain(
            "Send a new authenticated message to continue.",
          );
        }
      });
    },
  );

  it.each([
    "declaring plugin loaded",
    "native steering",
    "peer follow-up",
    "requester continuation after cohort settlement",
    "Control UI source",
    "unowned delegated source",
    "detached cron input",
    "mismatched agent",
    "mismatched session key",
    "mismatched incarnation",
    "mismatched lifecycle",
    "device revoked after admission",
    "role reassigned after admission",
  ] as const)("guards real automation writes for %s", async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sourceMissing = ["unowned delegated source", "detached cron input"].includes(scenario);
      const sourceMismatch = [
        "mismatched agent",
        "mismatched session key",
        "mismatched incarnation",
        "mismatched lifecycle",
      ].includes(scenario);
      const sourceUnavailable = sourceMissing || sourceMismatch;
      const inputProvenance: InputProvenance | undefined =
        scenario === "peer follow-up"
          ? interSession("sessions_send", "agent:main:dashboard:peer", "webchat")
          : scenario === "requester continuation after cohort settlement"
            ? interSession("subagent_settle", "agent:main:subagent:completed-child")
            : undefined;
      const config = {
        agents: { defaults: { model: "openai/gpt-4.1" } },
        tools: { allow: [AUTOMATIONS_TOOL_NAME] },
      };
      // The real Cron owner validates model availability even for a disabled job.
      // A private synthetic profile satisfies that prerequisite without calling a provider.
      await persistAuthProfileBatch({
        stateDir: state.stateDir,
        profiles: [
          {
            profileId: "openai:native-recovery-test",
            credential: createApiKeyCredential("openai", "synthetic-native-recovery-key"),
          },
        ],
      });
      setRuntimeConfigSnapshot(config);
      if (scenario === "declaring plugin loaded") {
        // Plain-text recovery with a declaring command present; the command is not replayed.
        const builder = createTestPluginRegistry();
        const record = createOwnershipRecord("recovery-native-command", {
          contracts: { commandRuntimeCapabilities: ["subagents"] },
        });
        builder.createApi(record, { config }).registerCommand({
          name: "pstack-recovery-probe",
          description: "Probe command presence during plain-text restart recovery",
          requireAuth: true,
          runtimeCapabilities: ["subagents"],
          handler: () => ({ text: "Command handler is separate from agent recovery" }),
        });
        builder.registry.plugins.push(record);
        setTestPluginRegistry(builder.registry);
        initializeGlobalHookRunner(builder.registry);
      }
      const cronStorePath = path.join(state.stateDir, "cron", "jobs.json");
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath: cronStorePath,
        cronEnabled: false,
        defaultAgentId: "main",
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
        listConfiguredChannels: async () => [],
      });
      const makeContext = () =>
        createDirectChatContext({
          cron,
          cronStorePath,
          getRuntimeConfig: () => config,
          validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
          getGatewayMethodRegistry: () => createRequestGatewayMethodRegistry(),
          trackExecution: trackAsyncWork,
        });
      const owner =
        scenario === "role reassigned after admission"
          ? ensureProfileForEmail("native-recovery-operator@example.test")
          : ensureGatewayOwnerProfile("Recovery owner");
      const fixture = await recoveryFixture(state.stateDir, owner.id, {
        context: makeContext(),
        config,
        sessionKey: SESSION,
        sessionId: SESSION_ID,
        clientInfo:
          scenario === "Control UI source"
            ? { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT }
            : { id: GATEWAY_CLIENT_IDS.MACOS_APP, mode: GATEWAY_CLIENT_MODES.UI },
        localOperator: scenario !== "Control UI source",
        inputProvenance,
        requesterOrigin:
          scenario === "peer follow-up"
            ? { sessionKey: "agent:main:dashboard:peer", operatorProfileId: owner.id }
            : undefined,
        sourceRunId:
          scenario === "requester continuation after cohort settlement"
            ? "announce:requester-settle:main:parent:completed-child:yield-1"
            : undefined,
        device: {
          ...pairedOperator(),
          deviceId: "native-recovery-device",
        },
      });
      expect(fixture.sourceAuthority.assertCurrent).toThrow("no longer active");
      const savedSource = sourceMissing
        ? undefined
        : {
            ...expectDefined(fixture.entry.restartRecoveryOperatorSource, "original host source"),
            ...(scenario === "mismatched agent" ? { agentId: "unrelated-agent" } : {}),
            ...(scenario === "mismatched session key"
              ? { sessionKey: "agent:main:unrelated-session" }
              : {}),
            ...(scenario === "mismatched incarnation" ? { sessionId: "unrelated-session" } : {}),
            ...(scenario === "mismatched lifecycle"
              ? { lifecycleRevision: "unrelated-lifecycle" }
              : {}),
          };
      await replaceSessionEntry(fixture.target, {
        ...fixture.entry,
        status: "interrupted",
        lifecycleRunId: fixture.target.sourceRunId,
        restartRecoveryOperatorSource: savedSource,
      });
      await appendInterruptedTurn(fixture.target, {
        cwd: state.workspaceDir,
        steering: scenario === "native steering",
        provenance:
          scenario === "detached cron input"
            ? { kind: "internal_system", sourceTool: "cron" }
            : inputProvenance,
      });

      // Dispose old SQLite handles and process-lifetime owners. A fresh context
      // must restore only the durable claim, never the closed original capability.
      await coldRestart(state.stateDir);
      const context = makeContext();
      const runtime = createRecoveryRuntime(context);
      let turnRegistration: ReturnType<typeof registerChatAbortController> | undefined;
      const { recoveryRunId: runId } = fixture.target;
      startTurn.mockImplementation(
        async ({ principal, assertAdmissionCurrent, controllerInput, io }) => {
          const authority = expectDefined(
            principal?.internal?.operatorRunAuthority,
            "restored owner",
          );
          expect(authority.profileId).toBe(owner.id);
          if (scenario === "device revoked after admission") {
            invalidateGatewayDeviceRevocation(context, "native-recovery-device", "operator");
          } else if (scenario === "role reassigned after admission") {
            setUserProfileRole(owner.id, "replacement-role");
          }
          assertAdmissionCurrent?.();
          authority.assertCurrent();
          // The service replacement must publish the preparation owner that the
          // real turn service registers before constructing or invoking tools.
          turnRegistration = registerChatAbortController({
            target: captureSessionTarget({
              storeScope: fixture.target.storePath,
              sessionKey: SESSION,
              incarnation: SESSION_ID,
              agentId: "main",
            }),
            sourceInput: controllerInput,
            agentId: "main",
            runId,
            sessionKey: SESSION,
            sessionId: SESSION_ID,
            kind: "agent",
            timeoutMs: resolveAgentTimeoutMs({ cfg: config }),
          });
          if (!turnRegistration.registered) {
            throw new Error("expected a registered recovery run");
          }
          io.emitStartOwner?.(runId, turnRegistration.entry);
          const writeAutomation: RequesterRun<void> = async (_identity, admitted) => {
            bindGatewayContextResolver(admitted, () => context);
            try {
              const tools = await createCreatorTransportTools({
                transport: "embedded",
                config,
                admitted,
                senderIsOwner: authority.scopes.includes("operator.admin"),
                workspaceDir: state.workspaceDir,
              });
              await tools.invoke(AUTOMATIONS_TOOL_NAME, {
                action: "add",
                job: {
                  name: "Recovered authorized task",
                  enabled: false,
                  schedule: { kind: "every", everyMs: 60000 },
                  sessionTarget: "current",
                  payload: { kind: "agentTurn", message: "Synthetic checkback" },
                  delivery: { mode: "none" },
                },
              });
            } finally {
              clearGatewayContextResolver(admitted);
            }
          };
          await withSessionTurn(
            {
              sessionKey: SESSION,
              sessionId: SESSION_ID,
              target: turnRegistration.entry.input.target,
              controllerInput: turnRegistration.entry.input,
              abortSignal: turnRegistration.controller.signal,
            },
            async () => {
              const client = createSyntheticPluginRuntimeClient({
                operatorRoleActor: { kind: "operator", profileId: authority.profileId },
                operatorRunAuthority: authority,
                scopes: [...authority.scopes],
              });
              const creator = expectDefined(
                resolveGatewayCronCreatorAuthorityAdmission({
                  runId,
                  resolvedSessionKey: SESSION,
                  sessionId: SESSION_ID,
                  client,
                  request: {
                    message: "Finish the accepted automation task",
                    idempotencyKey: runId,
                  },
                  hasRestoredCronContinuation: false,
                  isOneShotModelRun: false,
                  isRestartRecoveryResumeRun: true,
                }),
                "restored creator admission",
              );
              await withPluginRuntimeGatewayRequestScope(
                { client, context, isWebchatConnect: () => false },
                () => inRun(runId, creator, writeAutomation, authority),
              );
            },
          );
          io.emitAcceptance([true, { runId, status: "ok" }, undefined]);
          io.emitFinal([true, { runId, status: "ok" }, undefined]);
        },
      );
      try {
        await expect(
          markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir, cfg: {} }),
        ).resolves.toMatchObject({ marked: 1, skipped: 0 });
        const result = await recover(fixture, state.stateDir, runtime, config);
        const deviceRevoked = scenario === "device revoked after admission";
        expect(result).toEqual({
          ...settledRecovery,
          settled: deviceRevoked ? 0 : 1,
          failed: deviceRevoked ? 1 : 0,
        });
        expect(startTurn).toHaveBeenCalledTimes(sourceUnavailable ? 0 : 1);
        if (sourceMissing) {
          const entry = await readSessionEntryReadOnlyInWorker(fixture.target);
          expect(entry).toMatchObject({
            sessionId: fixture.entry.sessionId,
            status: "interrupted",
            abortedLastRun: false,
          });
          expect(entry?.mainRestartRecovery).toBeUndefined();
          expect(entry?.lastRunId).toBeDefined();
          expect(entry?.restartRecoveryTerminalRunIds).toContain(entry?.lastRunId);
          expect(entry?.restartRecoveryTerminalDeliveryEvidence).toBeUndefined();
        } else if (sourceMismatch) {
          // Current Gateway restoration owns exact-claim validation, not the
          // transcript classifier. Refusal must precede turn/tool execution.
          const entry = await readSessionEntryReadOnlyInWorker(fixture.target);
          expect(entry?.lastRunError).toBe(
            "Restart recovery operator source no longer owns this input.",
          );
          expect(entry?.mainRestartRecovery).toBeUndefined();
          expect(entry?.restartRecoveryOperatorSource).toBeUndefined();
          expect(entry?.abortedLastRun).toBe(false);
        }
        const jobs = (await loadCronStore(cronStorePath)).jobs;
        if (sourceUnavailable || scenario.includes("after admission")) {
          expect(jobs).toEqual([]);
        } else {
          expect(jobs).toMatchObject([
            {
              name: "Recovered authorized task",
              enabled: false,
              owner: { agentId: "main", sessionKey: SESSION },
            },
          ]);
        }
      } finally {
        turnRegistration?.cleanup();
        runtime.close();
        cron.stop();
        await cron.waitForIdle();
      }
    });
  });
});
