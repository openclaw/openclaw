import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { markRestartAbortedMainSessions } from "../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverStore } from "../agents/main-session-recovery/main-session-restart-recovery-store.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { appendTranscriptMessage, loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
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
  context: ReturnType<typeof chatContext>,
  target: OperatorRecoveryTarget,
  runId = target.recoveryRunId,
) {
  const registration = registerChatAbortController({
    chatAbortControllers: context.chatAbortControllers,
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
            activeRuns: [{ sessionKey, sessionId, runId, lifecycleGeneration: generation }],
            isActiveRun: () => true,
          });
          rotateAgentEventLifecycleGeneration();
          if (revoked && attempt === 1) {
            setUserProfileRole(profileId, "changed-role");
          }
          const runtime = createRuntime(() => context);
          const finish = createDeferred();
          let registration: ReturnType<typeof registerChatAbortController> | undefined;
          startTurn.mockImplementation(async ({ preflight, principal, io }) => {
            runId = expectDefined(preflight.request.idempotencyKey, "recovery run");
            const authority = expectDefined(
              principal?.internal?.operatorRunAuthority,
              "restored source authority",
            );
            expect(authority.profileId).toBe(profileId);
            expect(authority.assertCurrent).not.toThrow();
            registration = registerRecovery(context, target, runId);
            io.emitStartOwner?.(runId, registration.entry);
            registration.markExecutionStarted();
            io.emitAcceptance([true, { runId, status: "accepted" }, undefined]);
            io.emitExecutionStarted?.();
            await finish.promise;
            io.emitFinal([true, { runId, status: "ok" }, undefined]);
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
              settled: 0,
              failed: denied ? 1 : 0,
              skipped: 0,
            });
            expect(startTurn).toHaveBeenCalledTimes(denied ? 1 : attempt + 1);
            const retained = loadSessionEntry(target);
            expect(retained?.restartRecoveryOperatorSource).toEqual(source);
            expect(retained?.restartRecoveryDeliverySourceRunId).toBe(target.sourceRunId);
            expect(retained?.mainRestartRecovery?.tombstone).toBeUndefined();
          } finally {
            runtime.close();
            finish.resolve();
            await startTurn.mock.results.at(-1)?.value;
            registration?.cleanup();
          }
        }
      }, true);
    },
  );
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
        ).rejects.toThrow("dispatch does not match its operator claim");
        expect(startTurn).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["authenticated operator", "legacy claim"] as const)(
    "applies the actual admin-method fence to a %s principal",
    async (source) => {
      await withRecovery(async ({ target, context }) => {
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
        const options = {
          restartRecoveryOperatorTarget: source === "authenticated operator" ? target : undefined,
        };
        const result = runtime.recovery.dispatchAgent(recoveryRequest(target), undefined, options);
        if (source === "authenticated operator") {
          await expect(result).resolves.toMatchObject({ status: "ok" });
        } else {
          await expect(result).rejects.toThrow("missing scope: operator.admin");
        }
      });
    },
  );

  it.each([
    "registration replaced",
    "registration aborted",
    "lifecycle rotated",
    "Gateway closed",
    "Gateway context replaced",
  ] as const)("refuses retained operator work after its exact %s", async (boundary) => {
    await withRecovery(async ({ target, context }) => {
      let activeContext = context;
      const registration = registerRecovery(context, target);
      using runtime = createRuntime(() => activeContext);
      const entered = createDeferred<AgentTurnPrincipal>();
      const finish = createDeferred();
      startTurn.mockImplementation(async ({ principal, io }) => {
        const currentPrincipal = expectDefined(principal, "typed recovery principal");
        const runId = target.recoveryRunId;
        io.emitStartOwner?.(runId, registration.entry);
        io.emitAcceptance([true, { runId, status: "accepted" }, undefined], { runId });
        entered.resolve(currentPrincipal);
        await finish.promise;
        io.emitFinal([true, { runId, status: "ok" }, undefined]);
      });
      const options = { restartRecoveryOperatorTarget: target, expectFinal: true };
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
          // Same correlation identity cannot transfer the old registration's authority.
          context.chatAbortControllers.set(target.recoveryRunId, {
            ...registration.entry,
            controller: new AbortController(),
          });
        } else if (boundary === "registration aborted") {
          registration.controller.abort(new Error("Recovery aborted"));
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
          context.chatAbortControllers.set(target.recoveryRunId, registration.entry);
          expect(authority.assertCurrent).toThrow();
        }
      } finally {
        finish.resolve();
        await pending.catch(() => undefined);
        await startTurn.mock.results.at(-1)?.value;
        registration.cleanup();
      }
    });
  });
});
