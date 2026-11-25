import { expect, it, vi } from "vitest";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { getRpcSource } from "../../../sessions/session-controller.rpc-sources.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  bindSubagentSpawnCleanup,
  cleanupProvisionalSession,
  terminateAcceptedCollectorRun,
} from "./subagent-spawn-cleanup.js";

function sessionChangedError(): Error {
  return Object.assign(new Error("session changed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "session-changed" },
  });
}

const childSessionKey = "agent:main:subagent:child";
const runId = "gateway-run";
const identity = { expectedSessionId: "session-id", expectedLifecycleRevision: "session-revision" };

function terminate(options: Partial<Parameters<typeof terminateAcceptedCollectorRun>[0]>) {
  return terminateAcceptedCollectorRun({
    childSessionKey,
    gatewayRunId: runId,
    ...options,
  });
}

function setupCleanup(dispatchSessionMethod: () => Promise<unknown>) {
  const context = Object.assign({} as GatewayRequestContext, {
    lifecycleRuntime: { dispatchSessionMethod },
  });
  const target = captureSessionTarget({
    storeScope: "/synthetic/spawn-cleanup.db",
    sessionKey: childSessionKey,
    incarnation: identity.expectedSessionId,
  });
  const resolveGatewayContext = () => context;
  const register = (foreign = false) =>
    withPluginRuntimeGatewayContextResolver(foreign ? undefined : resolveGatewayContext, () =>
      registerChatAbortController({
        target: foreign
          ? captureSessionTarget({ ...target, storeScope: "/synthetic/foreign-cleanup.db" })
          : target,
        runId,
        sessionId: identity.expectedSessionId,
        sessionKey: childSessionKey,
        timeoutMs: 60_000,
      }),
    );
  const cleanup = bindSubagentSpawnCleanup({
    childSessionKey,
    target,
    resolveGatewayContext,
    isCurrent: () => true,
    canAbortAcceptedRun: () => true,
    getSessionIdentity: () => identity,
  });
  return { cleanup, register };
}

it("retains its physical RPC source across cleanup and refuses a same-ID successor", async () => {
  const response = createDeferredCore<{ aborted: boolean; runIds: string[] }>();
  const dispatchSessionMethod = vi.fn(() => response.promise);
  const { cleanup, register } = setupCleanup(dispatchSessionMethod);
  const original = register();
  const foreign = register(true);
  cleanup.bindAcceptedRun(runId);
  expect(cleanup.isCurrent()).toBe(true);
  const abortRequest = {
    method: "chat.abort",
    params: { sessionKey: childSessionKey, runId },
  };
  const request = cleanup.callGateway(abortRequest);
  original.cleanup();
  const successor = register();
  try {
    expect(original.registered).toBe(true);
    expect(foreign.registered).toBe(true);
    expect(successor.registered).toBe(true);
    expect(cleanup.isCurrent()).toBe(false);
    response.resolve({ aborted: true, runIds: [runId] });
    await expect(request).rejects.toThrow("Subagent spawn no longer owns this cleanup");
    expect(dispatchSessionMethod).toHaveBeenCalledOnce();
    expect(successor.controller.signal.aborted).toBe(false);
    expect(foreign.controller.signal.aborted).toBe(false);
    await expect(cleanup.callGateway(abortRequest)).rejects.toThrow(
      "Subagent spawn no longer owns this cleanup",
    );
    expect(dispatchSessionMethod).toHaveBeenCalledOnce();
  } finally {
    response.resolve({ aborted: false, runIds: [] });
    await request.catch(() => {});
    original.cleanup();
    successor.cleanup();
    foreign.cleanup();
  }
});

it("requires both frozen session identities before deletion", async () => {
  const callGateway = vi.fn();

  await expect(
    cleanupProvisionalSession("agent:main:subagent:child", {
      expectedSessionId: "session-id",
      callGateway,
    }),
  ).resolves.toBe(false);

  expect(callGateway).not.toHaveBeenCalled();
});

it("reports uncertain termination while retaining the accepted child", async () => {
  const failure = new Error("gateway unavailable");
  const dispatchSessionMethod = vi.fn(async () => {
    throw failure;
  });
  const { cleanup, register } = setupCleanup(dispatchSessionMethod);
  const source = register();
  if (!source.registered) {
    throw new Error("Cancelled cleanup proof requires a registered controller source");
  }
  let inputSettled = false;
  void source.entry.input.settlement.promise.then(() => {
    inputSettled = true;
  });
  cleanup.bindAcceptedRun(runId);
  try {
    await expect(cleanup.terminateAcceptedRun?.()).resolves.toEqual({
      status: "failed",
      error: failure,
    });
    expect(dispatchSessionMethod).toHaveBeenCalledOnce();
    expect(getRpcSource(runId)).toBe(source.entry);
    expect(source.controller.signal.aborted).toBe(false);
    expect(inputSettled).toBe(false);
  } finally {
    source.cleanup();
  }
});

it.each([
  ["missing run", { ok: true, aborted: false, runIds: [] }, false],
  [
    "different run and successor lifecycle",
    { ok: true, aborted: true, runIds: ["different-run"] },
    true,
  ],
] as const)("guards deletion after abort reports %s", async (_name, response, successor) => {
  const callGateway = vi.fn().mockResolvedValueOnce(response);
  if (successor) {
    callGateway.mockRejectedValueOnce(sessionChangedError());
  } else {
    callGateway.mockResolvedValueOnce({ deleted: true });
  }
  await expect(terminate({ ...identity, callGateway })).resolves.toBeUndefined();
  expect(callGateway).toHaveBeenCalledTimes(2);
  expect(callGateway).toHaveBeenNthCalledWith(2, {
    method: "sessions.delete",
    params: {
      key: "agent:main:subagent:child",
      agentId: "main",
      emitLifecycleHooks: false,
      deleteTranscript: true,
      expectedSessionId: "session-id",
      expectedLifecycleRevision: "session-revision",
    },
    timeoutMs: 60_000,
  });
});

it.each([false, true])("does not delete a settled run (durable=%s)", async (durable) => {
  const callGateway = vi.fn().mockResolvedValue({
    ok: true,
    aborted: !durable,
    runIds: durable ? [] : [runId],
  });
  await terminate(
    durable ? { callGateway, sessionCleanup: "preserve" } : { ...identity, callGateway },
  );
  expect(callGateway).toHaveBeenCalledOnce();
});

it("reports an abort failure without deleting or retrying a durable session", async () => {
  const failure = new Error("gateway unavailable");
  const callGateway = vi.fn().mockRejectedValue(failure);
  await expect(terminate({ sessionCleanup: "preserve", callGateway })).rejects.toBe(failure);
  expect(callGateway).toHaveBeenCalledOnce();
});
