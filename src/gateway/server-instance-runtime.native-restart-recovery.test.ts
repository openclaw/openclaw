import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { mainSessionRecoveryLog } from "../agents/main-session-recovery/main-session-restart-recovery-shared.js";
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
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "./server-methods/cron-creator-authority-admission.js";
import {
  inRun,
  SESSION,
  SESSION_ID,
  createCreatorTransportTools,
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

describe("cold restart recovery of native operator input", () => {
  it("retires stale operator recovery once and admits new messages to the rotated session", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const context = createDirectChatContext({ trackExecution: trackAsyncWork });
      const profile = ensureProfileForEmail("stale-recovery@example.test");
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context,
        profileId: profile.id,
        config: {},
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
      await appendTranscriptMessage(target, {
        message: { role: "user", content: "Continue the accepted task", timestamp: 1 },
      });
      await appendTranscriptMessage(target, {
        message: { role: "assistant", content: [], stopReason: "aborted", timestamp: 2 },
      });
      const originalTranscript = await loadTranscriptEvents(target);
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
      rotateAgentEventLifecycleGeneration();
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createRequestGatewayMethodRegistry(),
        isDispatchAvailable: () => true,
      });
      context.recoveryRuntime = runtime.recovery;
      const admit = () =>
        admitTestReplyTurn({
          ...target,
          expectedSessionId: target.sessionId,
          resolveGatewayContext: () => context,
        });
      try {
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
        expect(JSON.stringify(transcript)).toContain(
          "Send a new authenticated message to continue.",
        );
        const later = await admit();
        expect(later.status).toBe("owned");
        if (later.status === "owned") {
          later.operation.complete();
        }
        expect(await loadTranscriptEvents(target)).toEqual(transcript);
        expect(startTurn).not.toHaveBeenCalled();
      } finally {
        runtime.close();
      }
    });
  });

  it.each([
    "write operator",
    "trusted proxy",
    "delegated session",
    "revoked operator",
    "revoked operator with saved final",
  ] as const)(
    "settles one interrupted turn for %s without broadening its authority",
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const warnings: string[] = [];
        vi.spyOn(mainSessionRecoveryLog, "warn").mockImplementation((message) =>
          warnings.push(message),
        );
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
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context,
          profileId: profile.id,
          config: {},
          scopes,
          tokenlessDevice: scenario === "trusted proxy",
          sourceRunId:
            scenario === "delegated session"
              ? "announce:requester-settle:main:parent:child:yield-1"
              : undefined,
          inputProvenance:
            scenario === "delegated session"
              ? {
                  kind: "inter_session",
                  sourceTool: "subagent_settle",
                  sourceChannel: "internal",
                  sourceSessionKey: "agent:main:subagent:child",
                }
              : undefined,
        });
        await replaceSessionEntry(fixture.target, {
          ...fixture.entry,
          status: "interrupted",
          lifecycleRunId: fixture.target.sourceRunId,
          pendingFinalDelivery,
        });
        await appendTranscriptMessage(fixture.target, {
          message: { role: "user", content: "Continue the accepted task", timestamp: 1 },
        });
        await appendTranscriptMessage(fixture.target, {
          message: { role: "assistant", content: [], stopReason: "aborted", timestamp: 2 },
        });
        await cleanupSessionStateForTest({ stateDir: state.stateDir });
        rotateAgentEventLifecycleGeneration();
        if (revoked) {
          setUserProfileRole(profile.id, "revoked-role");
        }
        const runtime = createGatewayInstanceRuntime({
          getContext: () => context,
          getMethodRegistry: () => createRequestGatewayMethodRegistry(),
          isDispatchAvailable: () => true,
        });
        startTurn.mockImplementation(async ({ principal, io, preflight }) => {
          expect(principal?.internal?.operatorRunAuthority?.scopes).toEqual(scopes);
          io.emitAcceptance([
            true,
            { runId: preflight.request.idempotencyKey, status: "ok" },
            undefined,
          ]);
        });
        try {
          await markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir, cfg: {} });
          const recover = () =>
            recoverStore({
              storeAgentId: "main",
              storePath: fixture.target.storePath,
              stateDir: state.stateDir,
              cfg: {},
              handledSessionKeys: new Set(),
              gatewayRuntime: runtime.recovery,
            });
          expect(await recover(), warnings.join("\n")).toEqual({
            started: 0,
            settled: 1,
            failed: 0,
            skipped: 0,
          });
          const settledTranscript = await loadTranscriptEvents(fixture.target);
          await recover();
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
        } finally {
          runtime.close();
        }
      });
    },
  );

  it.each([
    "native source",
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
      const warnings: string[] = [];
      vi.spyOn(mainSessionRecoveryLog, "warn").mockImplementation((message) =>
        warnings.push(message),
      );
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
          ? {
              kind: "inter_session",
              sourceTool: "sessions_send",
              sourceChannel: "webchat",
              sourceSessionKey: "agent:main:dashboard:peer",
            }
          : scenario === "requester continuation after cohort settlement"
            ? {
                kind: "inter_session",
                sourceTool: "subagent_settle",
                sourceChannel: "internal",
                sourceSessionKey: "agent:main:subagent:completed-child",
              }
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
            credential: {
              type: "api_key",
              provider: "openai",
              key: "synthetic-native-recovery-key",
            },
          },
        ],
      });
      setRuntimeConfigSnapshot(config);
      if (scenario === "declaring plugin loaded") {
        // An additional plain-text recovery case proves compatibility with a
        // declaring command present, not recovery/replay of a command handler.
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
        expect(builder.registry.commands).toHaveLength(1);
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
      const fixture = await createOperatorRecoveryFixture({
        stateDir: state.stateDir,
        context: makeContext(),
        profileId: owner.id,
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
          deviceId: "native-recovery-device",
          publicKey: "synthetic-public-key",
          roles: ["operator"],
          approvedScopes: ["operator.admin"],
          tokens: {
            operator: {
              token: "synthetic-device-token",
              role: "operator",
              scopes: ["operator.admin"],
              createdAtMs: 1,
            },
          },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      });
      expect(fixture.sourceAuthority.assertCurrent).toThrow("no longer active");
      expect(fixture.entry.restartRecoverySourceIngress).toBe(
        scenario === "Control UI source" ? "control-ui" : "internal",
      );
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
      const messages = [
        {
          role: "user",
          content: "Finish the synthetic task",
          timestamp: 1,
          ...(inputProvenance ? { provenance: inputProvenance } : {}),
          ...(scenario === "detached cron input"
            ? { provenance: { kind: "internal_system", sourceTool: "cron" } }
            : {}),
        },
        ...(scenario === "native steering"
          ? [{ role: "user", content: "Also check its result", timestamp: 2 }]
          : []),
        { role: "assistant", content: [], stopReason: "aborted", timestamp: 3 },
      ];
      for (const message of messages) {
        await appendTranscriptMessage(fixture.target, { cwd: state.workspaceDir, message });
      }

      // Dispose old SQLite handles and process-lifetime owners. A fresh context
      // must restore only the durable claim, never the closed original capability.
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
      rotateAgentEventLifecycleGeneration();
      const context = makeContext();
      const runtime = createGatewayInstanceRuntime({
        getContext: () => context,
        getMethodRegistry: () => createRequestGatewayMethodRegistry(),
        isDispatchAvailable: () => true,
      });
      let turnRegistration: ReturnType<typeof registerChatAbortController> | undefined;
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
            runId: fixture.target.recoveryRunId,
            sessionKey: SESSION,
            sessionId: SESSION_ID,
            kind: "agent",
            timeoutMs: resolveAgentTimeoutMs({ cfg: config }),
          });
          if (!turnRegistration.registered) {
            throw new Error("expected a registered recovery run");
          }
          io.emitStartOwner?.(fixture.target.recoveryRunId, turnRegistration.entry);
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
                  runId: fixture.target.recoveryRunId,
                  resolvedSessionKey: SESSION,
                  sessionId: SESSION_ID,
                  client,
                  request: {
                    message: "Finish the accepted automation task",
                    idempotencyKey: fixture.target.recoveryRunId,
                  },
                  hasRestoredCronContinuation: false,
                  isOneShotModelRun: false,
                  isRestartRecoveryResumeRun: true,
                }),
                "restored creator admission",
              );
              await withPluginRuntimeGatewayRequestScope(
                { client, context, isWebchatConnect: () => false },
                () =>
                  inRun(
                    fixture.target.recoveryRunId,
                    creator,
                    async (_identity, admitted) => {
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
                    },
                    authority,
                  ),
              );
            },
          );
          io.emitAcceptance([
            true,
            { runId: fixture.target.recoveryRunId, status: "ok" },
            undefined,
          ]);
          io.emitFinal([true, { runId: fixture.target.recoveryRunId, status: "ok" }, undefined]);
        },
      );
      try {
        await expect(
          markStartupOrphanedMainSessionsForRecovery({ stateDir: state.stateDir, cfg: {} }),
        ).resolves.toMatchObject({ marked: 1, skipped: 0 });
        const result = await recoverStore({
          storeAgentId: "main",
          storePath: fixture.target.storePath,
          stateDir: state.stateDir,
          cfg: config,
          handledSessionKeys: new Set(),
          gatewayRuntime: runtime.recovery,
        });
        if (sourceMissing) {
          expect(result).toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
          expect(startTurn).not.toHaveBeenCalled();
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
          expect(result).toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
          expect(startTurn).not.toHaveBeenCalled();
          const entry = await readSessionEntryReadOnlyInWorker(fixture.target);
          expect(entry?.lastRunError).toBe(
            "Restart recovery operator source no longer owns this input.",
          );
          expect(entry?.mainRestartRecovery).toBeUndefined();
          expect(entry?.restartRecoveryOperatorSource).toBeUndefined();
          expect(entry?.abortedLastRun).toBe(false);
        } else if (scenario.includes("after admission")) {
          const revoked = scenario === "role reassigned after admission";
          expect(result).toEqual({
            started: 0,
            settled: revoked ? 1 : 0,
            failed: revoked ? 0 : 1,
            skipped: 0,
          });
          expect(startTurn).toHaveBeenCalledOnce();
        } else {
          expect(result, warnings.join("\n")).toEqual({
            started: 0,
            settled: 1,
            failed: 0,
            skipped: 0,
          });
          expect(startTurn).toHaveBeenCalledOnce();
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
          expect(jobs).toHaveLength(1);
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
