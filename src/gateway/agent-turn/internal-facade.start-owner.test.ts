import { beforeEach, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createChatRunState } from "../server-chat-state.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { createInternalAgentTurnFacade } from "./internal-facade.js";
import type { AgentTurnStartOwner } from "./internal-facade.types.js";

const startTurn = vi.hoisted(() => vi.fn());

// mock-isolation: The start-owner fixture supplies its request envelope without initializing the full Gateway method registry.
vi.mock("../server-methods.js", () => ({
  createRequestGatewayMethodRegistry: () => ({
    isControlPlaneWrite: () => false,
    isObservation: () => false,
  }),
  runWithGatewayRequestEnvelope: async (
    _method: string,
    _client: unknown,
    run: () => Promise<unknown>,
  ) => await run(),
}));
// mock-isolation: This synthetic start-owner context has no database-backed session policy; authorization is supplied by the fixture.
vi.mock("../server-methods/request-authorization.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
}));
// mock-isolation: The fixture supplies the admitted request without loading runtime config or the model catalog.
vi.mock("./agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));
// mock-isolation: The fixture publishes its existing source through startTurn without launching another agent execution.
vi.mock("./agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn }),
}));

beforeEach(() => {
  resetAgentEventsForTest();
  startTurn.mockReset();
});

it("observes a started owner without reentering its watchdog authority", async () => {
  const context = Object.assign({} as GatewayRequestContext, {
    trackExecution: trackAsyncWork,
    agentRunSeq: new Map(),
    broadcast: vi.fn(),
    chatRunState: createChatRunState(),
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
    nodeSendToSession: vi.fn(),
    removeChatRun: vi.fn(() => undefined),
  });
  const request = {
    agentId: "main",
    message: "resume",
    idempotencyKey: "observed-recovery",
    sessionKey: "agent:main:observed-recovery",
    expectedExistingSessionId: "observed-session",
  };
  const registration = registerChatAbortController({
    agentId: request.agentId,
    runId: request.idempotencyKey,
    sessionId: request.expectedExistingSessionId,
    sessionKey: request.sessionKey,
    target: captureSessionTarget({
      storeScope: "/synthetic/observed-recovery.db",
      sessionKey: request.sessionKey,
      incarnation: request.expectedExistingSessionId,
    }),
    kind: "agent",
    timeoutMs: 60_000,
  });
  if (!registration.registered) {
    throw new Error("Expected recovery source registration");
  }
  let owner: AgentTurnStartOwner | undefined;
  startTurn.mockImplementation(async ({ io }) => {
    io.emitStartOwner?.(request.idempotencyKey, registration.entry);
    io.emitAcceptance([true, { runId: request.idempotencyKey, status: "accepted" }, undefined], {
      runId: request.idempotencyKey,
    });
  });
  const facade = createInternalAgentTurnFacade({
    client: createSyntheticPluginRuntimeClient(),
    getContext: () => context,
  });
  try {
    await facade.dispatch(request, { onStartOwner: (value) => (owner = value) });
    expect(owner?.observe()).toMatchObject({ executionStarted: false });
    await claimRpcSourceForTest(registration.entry);
    const operation = registration.entry.input.claim?.operation;
    if (!owner || !operation) {
      throw new Error("Expected published owner and claimed controller operation");
    }
    const observedOwner = owner;
    let policyCurrent = true;
    let validatingPolicy = false;
    const assertCurrent = vi.fn(() => {
      if (validatingPolicy) {
        throw new Error("Start observation reentered effect authority");
      }
      validatingPolicy = true;
      try {
        if (!policyCurrent) {
          throw new Error("Recovery operator policy revoked");
        }
        expect(observedOwner.observe()).toMatchObject({ executionStarted: true });
      } finally {
        validatingPolicy = false;
      }
    });
    const attempt = operation.watchdog.attachAttempt({ assertCurrent });
    try {
      assertCurrent.mockClear();
      expect(observedOwner.observe()).toMatchObject({ executionStarted: true });
      expect(assertCurrent).not.toHaveBeenCalled();
      expect(observedOwner.abort()).toBe(false);
      expect(attempt.isCurrent()).toBe(true);
      expect(assertCurrent).toHaveBeenCalledOnce();
      policyCurrent = false;
      expect(attempt.isCurrent()).toBe(false);
      expect(assertCurrent).toHaveBeenCalledTimes(2);
    } finally {
      attempt.close();
    }
  } finally {
    registration.cleanup();
  }
});
