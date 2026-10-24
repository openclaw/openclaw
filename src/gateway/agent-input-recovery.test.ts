import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { GatewayInputRecovery } from "./agent-input-recovery.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { authorizeGatewayRequestPreDispatch } from "./server-methods/request-authorization.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

const request = {
  agentId: "main",
  sessionKey: "agent:main:recovery",
  expectedExistingSessionId: "session",
  idempotencyKey: "saved-run",
  message: "synthetic input",
};

it("retains every deferred group member when recovery fails before handoff", async () => {
  const gate = new GatewayInputRecovery();
  const pending = createDeferredCore();
  const error = new Error("child store unavailable");
  await gate.track(
    Promise.resolve({
      initial: Promise.resolve(),
      pending: new Map([
        ["main", pending.promise],
        ["child", pending.promise],
      ]),
      settled: pending.promise,
    }),
  );
  gate.releaseInitial();
  const waiting = gate.waitForAgentInputRecovery("main");
  pending.reject(error);
  await expect(waiting).rejects.toBe(error);
  expect(gate.isPending("main")).toBe(true);
  expect(gate.isPending("child")).toBe(true);
  expect(gate.isPending("unrelated")).toBe(false);
});

it("retains an initial recovery failure for later input waiters", async () => {
  const gate = new GatewayInputRecovery();
  const error = new Error("recovery discovery failed");
  const failed = Promise.reject(error);
  await expect(
    gate.track(
      Promise.resolve({
        initial: failed,
        pending: new Map(),
        settled: failed,
      }),
    ),
  ).rejects.toBe(error);
  await expect(gate.waitForAgentInputRecovery("main")).rejects.toBe(error);
  expect(gate.isPending("main")).toBe(true);
});

function authorization(method: string) {
  const context = createContext();
  context.inputRecovery = new GatewayInputRecovery();
  return {
    method,
    requestParams: request,
    context,
    client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
    methodRegistry: createGatewayMethodRegistry([]),
  };
}

it.each(["agent", "chat.send"])(
  "does not exempt a generic synthetic %s request from recovery",
  async (method) => {
    const result = await authorizeGatewayRequestPreDispatch(authorization(method));
    expect(result.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  },
);

it("revalidates an exact saved-input handoff and rejects a different target", async () => {
  const assertCurrent = vi.fn(() => {
    throw new Error("recovery custody revoked");
  });
  const recoveryInput = {
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    sessionId: request.expectedExistingSessionId,
    runId: request.idempotencyKey,
    assertCurrent,
  };
  const rejected = await authorizeGatewayRequestPreDispatch({
    ...authorization("agent"),
    recoveryInput: { ...recoveryInput, sessionId: "replaced-session" },
  });
  expect(rejected.error).toMatchObject({ code: "UNAVAILABLE" });
  expect(assertCurrent).not.toHaveBeenCalled();
  await expect(
    authorizeGatewayRequestPreDispatch({
      ...authorization("agent"),
      recoveryInput,
    }),
  ).rejects.toThrow("recovery custody revoked");
});
