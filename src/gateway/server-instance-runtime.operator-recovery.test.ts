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

// Keep the typed runtime and principal capture real; no model/provider execution is needed
// to observe its authorization boundary and exact controller-registration lifetime.
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
) =>
  createGatewayInstanceRuntime({
    getContext,
    getMethodRegistry: () => registry,
    isDispatchAvailable: () => true,
  });
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
    fixture: Awaited<ReturnType<typeof createOperatorRecoveryFixture>>,
    context: ReturnType<typeof chatContext>,
  ) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const context = chatContext();
    const profile = ensureProfileForEmail("runtime-recovery@example.test");
    const fixture = await createOperatorRecoveryFixture({
      stateDir,
      context,
      profileId: profile.id,
      config: {},
    });
    await run(fixture, context);
  });
}

describe("typed restart recovery operator admission", () => {
  it.each([false, true])(
    "retains an internal operator source across repeated restarts (revoked=%s)",
    async (revoked) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setRuntimeConfigSnapshot({});
        const profile = ensureProfileForEmail("repeat-recovery@example.test");
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: chatContext(),
          profileId: profile.id,
          config: {},
          sessionKey: "agent:main:dashboard:repeat-recovery",
          sourceIngress: "internal",
        });
        const source = fixture.entry.restartRecoveryOperatorSource;
        let runId = fixture.target.recoveryRunId;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const context = chatContext();
          context.getRuntimeConfig = () => ({});
          const generation = getAgentEventLifecycleGeneration();
          await appendTranscriptMessage(fixture.target, {
            message: {
              role: "user",
              content: "A reviewer has additional findings for the original task.",
              provenance: { kind: "inter_session", sourceTool: "sessions_send" },
            },
          });
          await appendTranscriptMessage(fixture.target, {
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [{ type: "toolCall", id: "inspect-" + attempt, name: "read" }],
            },
          });
          await markRestartAbortedMainSessions({
            resolveGatewayContext: () => context,
            stateDir: state.stateDir,
            activeRuns: [
              {
                sessionKey: fixture.target.sessionKey,
                sessionId: fixture.target.sessionId,
                runId,
                lifecycleGeneration: generation,
              },
            ],
            isActiveRun: () => true,
          });
          rotateAgentEventLifecycleGeneration();
          if (revoked && attempt === 1) {
            setUserProfileRole(profile.id, "changed-role");
          }
          const runtime = createRuntime(() => context);
          const finish = createDeferred();
          let registration: ReturnType<typeof registerChatAbortController> | undefined;
          let execution: Promise<void> | undefined;
          startTurn.mockImplementation(({ preflight, principal, io }) => {
            execution = (async () => {
              runId = expectDefined(preflight.request.idempotencyKey, "recovery run");
              const authority = expectDefined(
                principal?.internal?.operatorRunAuthority,
                "restored source authority",
              );
              expect(authority.profileId).toBe(profile.id);
              expect(authority.assertCurrent).not.toThrow();
              registration = registerRecovery(context, fixture.target, runId);
              io.emitStartOwner?.(runId, registration.entry);
              registration.markExecutionStarted();
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
              storePath: fixture.target.storePath,
              stateDir: state.stateDir,
              handledSessionKeys: new Set(),
              expectedTarget: fixture.target,
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
            const retained = loadSessionEntry(fixture.target);
            expect(retained?.restartRecoveryOperatorSource).toEqual(source);
            expect(retained?.restartRecoveryDeliverySourceRunId).toBe(fixture.target.sourceRunId);
            expect(retained?.mainRestartRecovery?.tombstone).toBeUndefined();
          } finally {
            runtime.close();
            finish.resolve();
            await execution;
            registration?.cleanup();
          }
        }
      });
    },
  );
  it.each(["agentId", "sessionKey", "expectedExistingSessionId", "idempotencyKey"] as const)(
    "rejects dispatch before authority restoration when %s differs from the original claim",
    async (field) => {
      await withRecovery(async (fixture, context) => {
        const runtime = createRuntime(() => context);
        const request = recoveryRequest(fixture.target);
        request[field] = "another-claim";
        try {
          await expect(
            runtime.recovery.dispatchAgent(request, undefined, {
              restartRecoveryOperatorTarget: fixture.target,
            }),
          ).rejects.toThrow("dispatch does not match its operator claim");
          expect(startTurn).not.toHaveBeenCalled();
        } finally {
          runtime.close();
        }
      });
    },
  );

  it.each(["authenticated operator", "legacy claim"] as const)(
    "applies the actual admin-method fence to a %s principal",
    async (source) => {
      await withRecovery(async (fixture, context) => {
        const registry = createGatewayMethodRegistry([
          {
            name: "cron.add",
            scope: "operator.admin",
            owner: { kind: "core", area: "cron" },
            handler: vi.fn(),
          },
        ]);
        const runtime = createRuntime(() => context, registry);
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
              : [true, { runId: fixture.target.recoveryRunId, status: "ok" }, undefined],
          );
        });
        const options = {
          restartRecoveryOperatorTarget:
            source === "authenticated operator" ? fixture.target : undefined,
        };
        try {
          const result = runtime.recovery.dispatchAgent(
            recoveryRequest(fixture.target),
            undefined,
            options,
          );
          if (source === "authenticated operator") {
            await expect(result).resolves.toMatchObject({ status: "ok" });
          } else {
            await expect(result).rejects.toThrow("missing scope: operator.admin");
          }
        } finally {
          runtime.close();
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
    await withRecovery(async (fixture, context) => {
      let activeContext = context;
      const registration = registerRecovery(context, fixture.target);
      const runtime = createRuntime(() => activeContext);
      const entered = createDeferred<AgentTurnPrincipal>();
      const finish = createDeferred();
      let execution: Promise<void> | undefined;
      startTurn.mockImplementation(({ principal, io }) => {
        execution = (async () => {
          const currentPrincipal = expectDefined(principal, "typed recovery principal");
          io.emitStartOwner?.(fixture.target.recoveryRunId, registration.entry);
          io.emitAcceptance(
            [true, { runId: fixture.target.recoveryRunId, status: "accepted" }, undefined],
            {
              runId: fixture.target.recoveryRunId,
            },
          );
          entered.resolve(currentPrincipal);
          await finish.promise;
          io.emitFinal([true, { runId: fixture.target.recoveryRunId, status: "ok" }, undefined]);
        })();
        return execution;
      });
      const options = { restartRecoveryOperatorTarget: fixture.target, expectFinal: true };
      const pending = runtime.recovery.dispatchAgent(
        recoveryRequest(fixture.target),
        undefined,
        options,
      );
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
          context.chatAbortControllers.set(fixture.target.recoveryRunId, {
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
          context.chatAbortControllers.set(fixture.target.recoveryRunId, registration.entry);
          expect(authority.assertCurrent).toThrow();
        }
      } finally {
        finish.resolve();
        await pending.catch(() => undefined);
        await execution;
        registration.cleanup();
        runtime.close();
      }
    });
  });
});
