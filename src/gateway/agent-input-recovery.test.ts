import { expect, it } from "vitest";
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
      pending: new Map(["main", "child"].map((id) => [id, pending.promise])),
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
  const progress = { initial: failed, pending: new Map<string, Promise<void>>(), settled: failed };
  await expect(gate.track(Promise.resolve(progress))).rejects.toBe(error);
  await expect(gate.waitForAgentInputRecovery("main")).rejects.toBe(error);
  expect(gate.isPending("main")).toBe(true);
});

function authorize(
  method: string,
  recoveryInput?: Parameters<typeof authorizeGatewayRequestPreDispatch>[0]["recoveryInput"],
) {
  const context = createContext();
  context.inputRecovery = new GatewayInputRecovery();
  return authorizeGatewayRequestPreDispatch({
    method,
    requestParams: request,
    context,
    client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
    methodRegistry: createGatewayMethodRegistry([]),
    recoveryInput,
  });
}

it.each(["agent", "chat.send"])("gates synthetic %s requests during recovery", async (method) => {
  const result = await authorize(method);
  expect(result.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
});

it("revalidates an exact saved-input handoff and rejects a different target", async () => {
  const recoveryInput = {
    agentId: request.agentId,
    sessionKey: request.sessionKey,
    sessionId: request.expectedExistingSessionId,
    runId: request.idempotencyKey,
    assertCurrent() {
      throw new Error("recovery custody revoked");
    },
  };
  const rejected = await authorize("agent", { ...recoveryInput, sessionId: "replaced-session" });
  expect(rejected.error).toMatchObject({ code: "UNAVAILABLE" });
  await expect(authorize("agent", recoveryInput)).rejects.toThrow("recovery custody revoked");
});
