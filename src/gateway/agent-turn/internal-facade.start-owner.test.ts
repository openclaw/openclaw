import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createGatewayRequestContext } from "../server-request-context.js";
import { makeContextParams } from "../server-request-context.test-support.js";
import { claimRpcSourceForTest } from "../test-helpers.rpc-source.js";
import { createInternalAgentTurnFacade } from "./internal-facade.js";
import type { AgentTurnStartOwner } from "./internal-facade.types.js";

const startTurn = vi.hoisted(() => vi.fn());

// mock-isolation: Supply the envelope without initializing the full method registry.
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
// mock-isolation: The fixture supplies authorization, not database-backed session policy.
vi.mock("../server-methods/request-authorization.js", () => ({
  authorizeGatewayRequestPreDispatch: async () => ({ error: null }),
}));
// mock-isolation: Supply admission without loading config or the model catalog.
vi.mock("./agent-request-preflight.js", () => ({
  prepareAgentRequestPreflight: ({ request }: { request: unknown }) => ({ request }),
}));
// mock-isolation: Publish the existing source without launching agent execution.
vi.mock("./agent-turn-service.js", () => ({
  createAgentTurnService: () => ({ startTurn }),
}));

it("observes a started owner without reentering its watchdog authority", async () => {
  resetAgentEventsForTest();
  startTurn.mockReset();
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = () => ({});
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
  assert(registration.registered, "Expected recovery source registration");
  using cleanup = new DisposableStack();
  cleanup.defer(registration.cleanup);
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
  await facade.dispatch(request, { onStartOwner: (value) => (owner = value) });
  expect(owner?.observe()).toMatchObject({ executionStarted: false });
  await claimRpcSourceForTest(registration.entry);
  const operation = expectDefined(registration.entry.input.claim?.operation, "claimed operation");
  const observedOwner = expectDefined(owner, "published owner");
  let policyCurrent = true;
  let validatingPolicy = false;
  const assertCurrent = vi.fn(() => {
    assert(!validatingPolicy, "Start observation reentered effect authority");
    validatingPolicy = true;
    try {
      assert(policyCurrent, "Recovery operator policy revoked");
      expect(observedOwner.observe()).toMatchObject({ executionStarted: true });
    } finally {
      validatingPolicy = false;
    }
  });
  const attempt = operation.watchdog.attachAttempt({ assertCurrent });
  cleanup.defer(() => attempt.close());
  assertCurrent.mockClear();
  expect(observedOwner.observe()).toMatchObject({ executionStarted: true });
  expect(assertCurrent).not.toHaveBeenCalled();
  expect(observedOwner.abort()).toBe(false);
  expect(attempt.isCurrent()).toBe(true);
  expect(assertCurrent).toHaveBeenCalledOnce();
  policyCurrent = false;
  expect(attempt.isCurrent()).toBe(false);
  expect(assertCurrent).toHaveBeenCalledTimes(2);
});
