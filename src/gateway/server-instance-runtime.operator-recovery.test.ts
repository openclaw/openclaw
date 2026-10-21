import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { markRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { createRestartRecoveryRequesterSource } from "../agents/requester-run-recovery-source.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import type { SessionControllerInput } from "../sessions/session-controller.contracts.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import {
  isRpcSourceExecuting,
  updateRpcSourceSessionId,
} from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { createAgentTurnService } from "./agent-turn/agent-turn-service.js";
import type { AgentTurnPrincipal } from "./agent-turn/types.js";
import { registerChatAbortController } from "./chat-abort.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type { OperatorRecoveryTarget } from "./operator-run-recovery.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewayInstanceRuntime } from "./server-instance-runtime.js";
import { authorizeGatewayMethod } from "./server-methods/method-authorization.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "./test-helpers.rpc-source.js";

const startTurn = vi.hoisted(() => vi.fn<ReturnType<typeof createAgentTurnService>["startTurn"]>());

// mock-isolation: Keep request-envelope plumbing isolated; the real method registry authorization is exercised below.
vi.mock("./server-methods.js", () => ({
  createRequestGatewayMethodRegistry: () => ({ isControlPlaneWrite: () => false }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));
// mock-isolation: Bypass unrelated ingress admission; this test exercises real restored-principal method authorization.
vi.mock("./server-methods/request-authorization.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
}));
// mock-isolation: Exclude model preparation while testing the typed recovery admission and exact owner lifetime.
vi.mock("./agent-turn/agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));
// mock-isolation: Control exact registration and await boundaries without starting provider execution.
vi.mock("./agent-turn/agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn, waitForTurn: vi.fn() }),
}));

afterEach(() => {
  startTurn.mockReset();
  resetAgentEventsForTest();
});

const chatContext = () => createDirectChatContext({ trackExecution: trackAsyncWork });
const createRuntime = (
  getContext: () => ReturnType<typeof chatContext>,
  registry = createGatewayMethodRegistry([]),
) => {
  const runtime = createGatewayInstanceRuntime({
    getContext,
    getMethodRegistry: () => registry,
    isDispatchAvailable: () => true,
  });
  return Object.assign(runtime, { [Symbol.dispose]: runtime.close });
};
const recoveryRequest = (target: OperatorRecoveryTarget) => ({
  message: "Continue the interrupted turn",
  agentId: target.agentId,
  sessionKey: target.sessionKey,
  expectedExistingSessionId: target.sessionId,
  idempotencyKey: target.recoveryRunId,
});
function registerRecovery(
  target: OperatorRecoveryTarget,
  runId = target.recoveryRunId,
  sourceInput?: SessionControllerInput,
) {
  const registration = registerChatAbortController({
    target: captureSessionTarget({
      storeScope: target.storePath,
      sessionKey: target.sessionKey,
      incarnation: target.sessionId,
      agentId: target.agentId,
    }),
    sourceInput,
    runId,
    agentId: "main",
    sessionKey: target.sessionKey,
    sessionId: target.sessionId,
    lifecycleGeneration: getAgentEventLifecycleGeneration(),
    timeoutMs: 60_000,
    kind: "agent",
  });
  if (!registration.registered) {
    throw new Error("Expected a fresh recovery controller");
  }
  return registration;
}
async function withRecovery(
  run: (
    fixture: Awaited<ReturnType<typeof createOperatorRecoveryFixture>> & {
      stateDir: string;
      profileId: string;
    },
  ) => Promise<void>,
  internal = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    if (internal) {
      setRuntimeConfigSnapshot({});
    }
    const context = chatContext();
    const profile = ensureProfileForEmail("runtime-recovery@example.test");
    const fixture = await createOperatorRecoveryFixture({
      stateDir,
      context,
      profileId: profile.id,
      config: {},
      ...(internal
        ? { sessionKey: "agent:main:dashboard:repeat-recovery", sourceIngress: "internal" as const }
        : {}),
    });
    await run({ ...fixture, stateDir, profileId: profile.id });
  });
}

describe("typed restart recovery operator admission", () => {
  it.each([false, true])(
    "retains an internal operator source across repeated restarts (revoked=%s)",
    async (revoked) => {
      await withRecovery(async ({ entry, target, stateDir, profileId }) => {
        const source = entry.restartRecoveryOperatorSource;
        let runId = target.recoveryRunId;
        const { sessionKey, sessionId } = target;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const context = chatContext();
          context.getRuntimeConfig = () => ({});
          const generation = getAgentEventLifecycleGeneration();
          await appendTranscriptMessage(target, {
            message: {
              role: "user",
              content: "A reviewer has additional findings for the original task.",
              provenance: { kind: "inter_session", sourceTool: "sessions_send" },
            },
          });
          await appendTranscriptMessage(target, {
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "inspect-" + attempt, name: "read" }],
            },
          });
          await markRestartAbortedMainSessions({
            resolveGatewayContext: () => context,
            stateDir,
            activeRuns: [
              {
                storePath: target.storePath,
                agentId: target.agentId,
                sessionKey,
                sessionId,
                runId,
                lifecycleGeneration: generation,
              },
            ],
            isActiveRun: () => true,
          });
          rotateAgentEventLifecycleGeneration();
          if (revoked && attempt === 1) {
            setUserProfileRole(profileId, "changed-role");
          }
          const runtime = createRuntime(() => context);
          const finish = createDeferred();
          let registration: ReturnType<typeof registerChatAbortController> | undefined;
          let execution: Promise<void> | undefined;
          let releaseTurn: (() => void) | undefined;
          startTurn.mockImplementation(({ controllerInput, preflight, principal, io }) => {
            execution = (async () => {
              runId = expectDefined(preflight.request.idempotencyKey, "recovery run");
              const authority = expectDefined(
                principal?.internal?.operatorRunAuthority,
                "restored source authority",
              );
              expect(authority.profileId).toBe(profileId);
              expect(authority.assertCurrent).not.toThrow();
              registration = registerRecovery(target, runId, controllerInput);
              io.emitStartOwner?.(runId, registration.entry);
              registration.initializeTiming();
              releaseTurn = await claimRpcSourceForTest(registration.entry);
              expect(registration.markExecutionStarted()).toBe(true);
              io.emitAcceptance([true, { runId, status: "accepted" }, undefined]);
              io.emitExecutionStarted?.();
              await finish.promise;
              io.emitFinal([true, { runId, status: "ok" }, undefined]);
            })();
            return execution;
          });
          try {
            const denied = revoked && attempt === 1;
            const skipped: string[] = [];
            const outcome = await recoverStore({
              onSkipped: (reason) => skipped.push(reason),
              cfg: {},
              storePath: target.storePath,
              stateDir,
              handledSessionKeys: new Set(),
              expectedTarget: target,
              gatewayRuntime: runtime.recovery,
            });
            expect(skipped).toEqual([]);
            expect(outcome).toEqual({
              started: denied ? 0 : 1,
              settled: denied ? 1 : 0,
              failed: 0,
              skipped: 0,
            });
            expect(startTurn).toHaveBeenCalledTimes(denied ? 1 : attempt + 1);
            const retained = loadSessionEntry(target);
            expect(retained?.restartRecoveryOperatorSource).toEqual(source);
            expect(retained?.restartRecoveryDeliverySourceRunId).toBe(target.sourceRunId);
            if (denied) {
              expect(retained?.mainRestartRecovery?.tombstone?.reason).toContain("operator");
              expect(retained?.status).toBe("failed");
            } else {
              expect(retained?.mainRestartRecovery?.tombstone).toBeUndefined();
            }
          } finally {
            runtime.close();
            finish.resolve();
            try {
              await execution;
            } finally {
              releaseTurn?.();
              registration?.cleanup();
              await registration?.entry?.input.settlement.promise;
            }
          }
        }
      }, true);
    },
  );
  it("resumes a retained channel requester after its child completion cohort is gone", async () => {
    await withRecovery(async (fixture) => {
      const { context, stateDir } = fixture;
      const target = {
        ...fixture.target,
        sourceRunId: "announce:requester-settle:main:parent:completed-child:yield-1",
      };
      const requesterOrigin = {
        sessionKey: "agent:main:slack:channel:original-requester",
        messageProvider: "slack",
        senderId: "original-channel-requester",
      };
      const entry = {
        ...fixture.entry,
        restartRecoveryDeliverySourceRunId: target.sourceRunId,
        restartRecoveryOperatorSource: undefined,
      };
      await replaceSessionEntry(target, {
        ...entry,
        restartRecoveryRequesterSource: expectDefined(
          createRestartRecoveryRequesterSource({ ...target, entry, requesterOrigin }),
          "retained channel requester",
        ),
      });
      await appendTranscriptMessage(target, {
        message: {
          role: "user",
          content: "Use the completed child's findings to finish my original request.",
          provenance: {
            kind: "inter_session",
            sourceTool: "subagent_settle",
            sourceSessionKey: "agent:main:subagent:completed-child",
          },
        },
      });
      await appendTranscriptMessage(target, {
        message: { role: "assistant", content: [], stopReason: "aborted" },
      });
      const marked = await markRestartAbortedMainSessions({
        resolveGatewayContext: () => context,
        stateDir,
        activeRuns: [
          {
            storePath: target.storePath,
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            runId: target.recoveryRunId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        ],
        isActiveRun: () => true,
      });
      expect(marked).toEqual({ marked: 1, skipped: 0 });
      rotateAgentEventLifecycleGeneration();
      expect(listSubagentRunsForRequester(target.sessionKey)).toEqual([]);
      using runtime = createRuntime(() => context);
      const finish = createDeferred();
      let registration: ReturnType<typeof registerChatAbortController> | undefined;
      let releaseTurn: (() => void) | undefined;
      startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
        const runId = expectDefined(preflight.request.idempotencyKey, "recovery run");
        registration = registerRecovery(target, runId, controllerInput);
        io.emitStartOwner?.(runId, registration.entry);
        registration.initializeTiming();
        releaseTurn = await claimRpcSourceForTest(registration.entry);
        expect(registration.markExecutionStarted()).toBe(true);
        io.emitAcceptance([true, { runId, status: "accepted" }, undefined]);
        io.emitExecutionStarted?.();
        await finish.promise;
        io.emitFinal([true, { runId, status: "ok" }, undefined]);
      });
      try {
        const outcome = await recoverStore({
          cfg: {},
          storePath: target.storePath,
          stateDir,
          handledSessionKeys: new Set(),
          expectedTarget: target,
          gatewayRuntime: runtime.recovery,
        });
        expect(outcome).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
        expect(startTurn).toHaveBeenCalledOnce();
        const principal = expectDefined(
          startTurn.mock.calls[0]?.[0].principal,
          "recovered principal",
        );
        expect(principal.internal?.agentToolCaller?.requesterOrigin).toEqual(requesterOrigin);
        expect(principal.internal?.operatorRunAuthority).toBeUndefined();
      } finally {
        finish.resolve();
        try {
          await startTurn.mock.results.at(-1)?.value;
        } finally {
          releaseTurn?.();
          registration?.cleanup();
          await registration?.entry?.input.settlement.promise;
        }
      }
    }, true);
  });

  it.each(["agentId", "sessionKey", "expectedExistingSessionId", "idempotencyKey"] as const)(
    "rejects dispatch before authority restoration when %s differs from the original claim",
    async (field) => {
      await withRecovery(async ({ target, context }) => {
        using runtime = createRuntime(() => context);
        const request = recoveryRequest(target);
        request[field] = "another-claim";
        await expect(
          runtime.recovery.dispatchAgent(request, undefined, {
            restartRecoveryOperatorTarget: target,
          }),
        ).rejects.toThrow("dispatch does not match its source claim");
        expect(startTurn).not.toHaveBeenCalled();
      });
    },
  );

  it.each([
    { source: "authenticated operator", operator: true, requester: "absent", expected: "accepted" },
    { source: "legacy claim", operator: false, requester: "absent", expected: "scope refusal" },
    { source: "matching requester", operator: true, requester: "matching", expected: "accepted" },
    {
      source: "native queued requester",
      operator: true,
      requester: "matching",
      expected: "accepted",
    },
    {
      source: "native queued mismatched requester",
      operator: true,
      requester: "different",
      expected: "identity refusal",
    },
    {
      source: "mismatched requester",
      operator: true,
      requester: "different",
      expected: "identity refusal",
    },
    {
      source: "requester without operator authority",
      operator: false,
      requester: "matching",
      expected: "identity refusal",
    },
  ] as const)(
    "applies recovery admission and the actual admin-method fence to $source",
    async ({ source, operator, requester, expected }) => {
      await withRecovery(async (fixture) => {
        const { target, context, entry, profileId } = fixture;
        const queued = source.startsWith("native queued");
        const requesterOrigin = {
          sessionKey: target.sessionKey,
          operatorProfileId: requester === "matching" ? profileId : "another-requester",
        };
        if (requester !== "absent" && !queued) {
          await replaceSessionEntry(target, {
            ...entry,
            restartRecoveryRequesterSource: expectDefined(
              createRestartRecoveryRequesterSource({
                ...target,
                entry,
                requesterOrigin,
              }),
              "host-captured requester source",
            ),
          });
        }
        const registry = createGatewayMethodRegistry([
          {
            name: "cron.add",
            scope: "operator.admin",
            owner: { kind: "core", area: "cron" },
            handler: vi.fn(),
          },
        ]);
        using runtime = createRuntime(() => context, registry);
        startTurn.mockImplementation(async ({ principal, io }) => {
          const authorization = authorizeGatewayMethod(
            "cron.add",
            principal,
            {},
            registry,
            context,
          );
          io.emitAcceptance(
            authorization.error
              ? [false, undefined, authorization.error]
              : [true, { runId: target.recoveryRunId, status: "ok" }, undefined],
          );
        });
        const retained = queued
          ? expectDefined(await fixture.restore(), "queued source authority")
          : undefined;
        const options = queued
          ? {
              operatorRunAuthority: retained?.authority,
              agentToolCaller: {
                agentId: "main",
                sessionKey: target.sessionKey,
                requesterOrigin,
              },
            }
          : {
              restartRecoveryOperatorTarget: operator ? target : undefined,
              restartRecoveryRequesterTarget: requester !== "absent" ? target : undefined,
            };
        try {
          const result = runtime.recovery.dispatchAgent(
            recoveryRequest(target),
            undefined,
            options,
          );
          if (expected === "accepted") {
            await expect(result).resolves.toMatchObject({ status: "ok" });
            expect(startTurn).toHaveBeenCalledOnce();
          } else if (expected === "identity refusal") {
            await expect(result).rejects.toThrow("requester has no matching operator authority");
            expect(startTurn).not.toHaveBeenCalled();
          } else {
            await expect(result).rejects.toThrow("missing scope: operator.admin");
            expect(startTurn).toHaveBeenCalledOnce();
          }
        } finally {
          retained?.release();
        }
      });
    },
  );

  it.each([
    "registration replaced",
    "registration aborted",
    "caller admission revoked",
    "lifecycle rotated",
    "Gateway closed",
    "Gateway context replaced",
  ] as const)("refuses retained operator work after its exact %s", async (boundary) => {
    await withRecovery(async ({ target, context, entry, profileId }) => {
      let activeContext = context;
      const registration = registerRecovery(target);
      using runtime = createRuntime(() => activeContext);
      const entered = createDeferred<AgentTurnPrincipal>();
      const finish = createDeferred();
      let admissionCurrent = true;
      let executionStarted = false;
      let cancellationCurrent: (() => void) | undefined;
      let releaseTurn: (() => void) | undefined;
      startTurn.mockImplementation(async ({ principal, io, assertCancellationCurrent }) => {
        cancellationCurrent = assertCancellationCurrent;
        const currentPrincipal = expectDefined(principal, "typed recovery principal");
        const runId = target.recoveryRunId;
        io.emitStartOwner?.(runId, registration.entry);
        io.emitAcceptance([true, { runId, status: "accepted" }, undefined], { runId });
        if (boundary === "registration replaced") {
          registration.initializeTiming();
          releaseTurn = await claimRpcSourceForTest(registration.entry);
          expect(registration.markExecutionStarted()).toBe(true);
          io.emitExecutionStarted?.();
        }
        entered.resolve(currentPrincipal);
        await finish.promise;
        io.emitFinal([true, { runId, status: "ok" }, undefined]);
      });
      const options = {
        restartRecoveryOperatorTarget: target,
        expectFinal: true,
        assertAdmissionCurrent: () => {
          if (!admissionCurrent) {
            throw new Error("Recovery admission ended after execution started");
          }
        },
        ...(boundary === "registration replaced"
          ? {
              onExecutionStarted: () => {
                executionStarted = true;
              },
            }
          : {}),
      };
      const pending = runtime.recovery.dispatchAgent(recoveryRequest(target), undefined, options);
      try {
        const principal = await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Recovery dispatch settled before publishing its typed principal",
        );
        const authority = expectDefined(
          principal.internal?.operatorRunAuthority,
          "restored typed authority",
        );
        expect(authority.assertCurrent).not.toThrow();
        if (boundary === "registration replaced") {
          expect(executionStarted).toBe(true);
          expect(isRpcSourceExecuting(registration.entry)).toBe(true);
          const accepted = await acceptCompactionSuccessor({
            currentTarget: target,
            expectedEntry: {
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
              activeWriterRunId: entry.activeWriterRunId,
            },
            assertActive: authority.assertCurrent,
            result: {
              ok: true,
              compacted: true,
              result: { sessionId: "runtime-successor", tokensBefore: 120, tokensAfter: 42 },
            },
          });
          // Match the execution owner's onSessionIdChanged on this same registration.
          updateRpcSourceSessionId(registration.entry, accepted.entry.sessionId);
          expect(authority.assertCurrent).not.toThrow();
          admissionCurrent = false;
          expect(authority.assertCurrent).not.toThrow();
          // Same correlation identity cannot transfer the old registration's authority.
          rpcSourceTesting.set(
            target.recoveryRunId,
            createRpcSourceForTest(
              {},
              {
                runId: target.recoveryRunId,
                storeScope: target.storePath,
                sessionKey: target.sessionKey,
                sessionId: target.sessionId,
                agentId: target.agentId,
              },
            ),
          );
        } else if (boundary === "registration aborted") {
          registration.controller.abort(new Error("Recovery aborted"));
          const assertCancellation = expectDefined(cancellationCurrent, "cancellation authority");
          expect(assertCancellation).not.toThrow();
          setUserProfileRole(profileId, "changed-role");
          expect(assertCancellation).toThrow();
        } else if (boundary === "caller admission revoked") {
          admissionCurrent = false;
          registration.controller.abort(new Error("Recovery caller revoked"));
          expect(expectDefined(cancellationCurrent, "cancellation authority")).toThrow();
        } else if (boundary === "lifecycle rotated") {
          rotateAgentEventLifecycleGeneration();
        } else if (boundary === "Gateway closed") {
          runtime.close();
        } else {
          activeContext = chatContext();
        }
        expect(authority.assertCurrent).toThrow();
        if (boundary === "registration replaced") {
          // Once refusal is observed, putting the same old row back cannot revive tools.
          rpcSourceTesting.set(target.recoveryRunId, registration.entry);
          expect(authority.assertCurrent).toThrow();
          admissionCurrent = true;
          registration.controller.abort(new Error("Replaced recovery aborted"));
          expect(expectDefined(cancellationCurrent, "cancellation authority")).toThrow();
        }
      } finally {
        finish.resolve();
        try {
          await pending.catch(() => undefined);
          await startTurn.mock.results.at(-1)?.value;
        } finally {
          releaseTurn?.();
          registration.cleanup();
          await registration.entry.input.settlement.promise;
        }
      }
    });
  });
});
