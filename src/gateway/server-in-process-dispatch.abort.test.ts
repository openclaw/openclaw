/** Proves in-process Gateway cancellation reaches real paired-node invocation state. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { WorkerTaskError } from "../../packages/worker-runtime/src/worker-task-error.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient } from "./node-registry.test-helpers.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const handleGatewayRequest = vi.hoisted(() => vi.fn());

vi.mock("./server-methods.js", () => ({ handleGatewayRequest }));

const activeRegistries = new Set<NodeRegistry>();
const nodeParams = { nodeId: "paired-node", command: "ollama.chat" };

function dispatch(
  method = "node.invoke",
  options: Partial<Parameters<typeof dispatchGatewayRequestInProcessRaw>[2]> = {},
) {
  return dispatchGatewayRequestInProcessRaw(
    method,
    method === "node.invoke"
      ? nodeParams
      : method === "chat.history"
        ? { sessionKey: "synthetic" }
        : {},
    {
      client: null,
      context: { trackExecution: trackAsyncWork } as GatewayRequestContext,
      ...options,
    },
  );
}

afterEach(() => {
  for (const registry of activeRegistries) {
    registry.unregister("paired-node-connection");
  }
  activeRegistries.clear();
  handleGatewayRequest.mockReset();
});

function registerPairedNode(): { registry: NodeRegistry; frames: string[] } {
  const frames: string[] = [];
  const registry = new NodeRegistry();
  activeRegistries.add(registry);
  registry.register(
    makeClient("paired-node-connection", "paired-node", frames, {
      clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
      platform: "linux",
      caps: ["local-inference"],
      commands: ["ollama.chat"],
    }),
    { pairingIdentity: "paired-node-identity" },
  );
  return { registry, frames };
}

describe("in-process paired-node invocation cancellation", () => {
  it.each([true, false])(
    "requires ok=true before waiting beyond an accepted-shaped response (ok=%s)",
    async (ok) => {
      const onAccepted = vi.fn();
      const error = { code: "UNAVAILABLE", message: "rejected" };
      const accepted = { status: "accepted", runId: "run-1" };
      const final = { status: "ok", runId: "run-1" };
      handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
        options.respond(ok, accepted, ok ? undefined : error);
        options.respond(true, final);
      });
      await expect(dispatch("agent", { expectFinal: true, onAccepted })).resolves.toMatchObject(
        ok ? { ok: true, payload: final } : { ok: false, payload: accepted, error },
      );
      expect(onAccepted.mock.calls).toEqual(ok ? [[accepted]] : []);
    },
  );

  it("cancels a real first-party paired-node invocation and removes its pending work", async () => {
    const { registry, frames } = registerPairedNode();
    const controller = new AbortController();
    handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
      const result = await registry.invoke({
        nodeId: "paired-node",
        command: "ollama.chat",
        timeoutMs: 10_000,
        signal: options.signal,
      });
      options.respond(
        result.ok,
        result.payload,
        result.error
          ? {
              code: result.error.code ?? "UNAVAILABLE",
              message: result.error.message ?? "node invocation failed",
            }
          : undefined,
      );
    });

    const invocation = dispatch("node.invoke", { signal: controller.signal });
    await vi.waitFor(() => expect(frames).toHaveLength(1));

    controller.abort(new Error("inference caller disconnected"));

    await expect(invocation).rejects.toThrow("inference caller disconnected");
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    const request = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    expect(JSON.parse(frames[1] ?? "{}")).toMatchObject({
      event: "node.invoke.cancel",
      payload: { invokeId: request.payload?.id, nodeId: "paired-node" },
    });
    expect(handleGatewayRequest).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it.each([undefined, 10_000])(
    "observes a worker failure after its caller aborts during dispatch (timeout=%s)",
    async (timeoutMs) => {
      const controller = new AbortController();
      const aborted = new Error("history caller disconnected");
      const result = createDeferredCore();
      const unhandled = vi.fn();
      handleGatewayRequest.mockImplementation(async () => {
        controller.abort(aborted);
        await result.promise;
      });
      process.on("unhandledRejection", unhandled);
      try {
        const request = dispatch("chat.history", { signal: controller.signal, timeoutMs });
        await expect(request).rejects.toBe(aborted);
        result.reject(
          new WorkerTaskError("ERR_WORKER_OUT_OF_MEMORY: synthetic worker failure", "unavailable"),
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );

  it("keeps cancellation ahead of an already-delivered response with a deadline", async () => {
    const controller = new AbortController();
    const aborted = new Error("history caller disconnected");
    handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
      options.respond(true, { messages: [] });
      controller.abort(aborted);
    });
    await expect(
      dispatch("chat.history", { signal: controller.signal, timeoutMs: 10_000 }),
    ).rejects.toBe(aborted);
  });

  it("rejects an already-canceled invocation without dispatching a Gateway request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("inference already canceled"));

    await expect(dispatch("node.invoke", { signal: controller.signal })).rejects.toThrow(
      "inference already canceled",
    );
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  it("normalizes a pre-aborted non-Error reason without dispatching a Gateway request", async () => {
    const signal = AbortSignal.abort("inference caller disconnected");

    await expect(dispatch("node.invoke", { signal })).rejects.toMatchObject({
      name: "AbortError",
      message: "gateway request aborted for node.invoke",
      cause: "inference caller disconnected",
    });
    expect(handleGatewayRequest).not.toHaveBeenCalled();
  });

  it("preserves the legacy in-process request shape when no signal is supplied", async () => {
    handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
      options.respond(true, { ok: true });
    });

    await expect(dispatch()).resolves.toMatchObject({ ok: true, payload: { ok: true } });
    expect(handleGatewayRequest.mock.calls[0]?.[0]).not.toHaveProperty("signal");
  });
});
