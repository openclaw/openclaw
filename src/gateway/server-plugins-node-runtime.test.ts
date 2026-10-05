import { expect, it, vi } from "vitest";
import { NodeRegistry } from "./node-registry.js";
import { openOwnedGatewayNodeDuplex } from "./server-plugins-node-runtime.js";

const observation = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (name: string) => {
      const logger = original.createSubsystemLogger(name);
      return name === "gateway/node-duplex" ? { ...logger, info: observation.info } : logger;
    },
  };
});

it.each([
  "invocation_resolved",
  "invocation_rejected",
  "owner_signal",
  "caller_close",
  "framing_error",
] as const)("observes %s without exposing command, payload or rejection text", async (origin) => {
  observation.info.mockClear();
  const privateText = "synthetic-private-command-body-and-token";
  const failure = new Error(privateText);
  const controller = new AbortController();
  let settle!: () => void;
  let reject!: (error: Error) => void;
  let progress!: (chunk: string) => void;
  const result = { body: privateText };
  const invoke: Parameters<typeof openOwnedGatewayNodeDuplex>[0]["invokeNode"] = async (
    _params,
    stream,
    signal,
  ) => {
    stream?.onDispatchReady?.("invoke-test");
    stream?.onProgress(JSON.stringify({ v: 1, kind: "ready" }));
    progress = (chunk) => stream?.onProgress(chunk);
    await new Promise<void>((resolve, rejectPromise) => {
      settle = resolve;
      reject = rejectPromise;
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return result;
  };
  const channel = await openOwnedGatewayNodeDuplex({
    params: { nodeId: "node-test", command: privateText, params: { token: privateText } },
    context: { nodeRegistry: new NodeRegistry() },
    invokeNode: invoke,
    signal: controller.signal,
    assertCurrent: () => {},
  });
  try {
    if (origin === "invocation_rejected") {
      const rejected = expect(channel.closed).rejects.toBe(failure);
      reject(failure);
      await rejected;
    } else if (origin === "invocation_resolved") {
      settle();
      expect(await channel.closed).toBe(result);
    } else {
      const rejected = expect(channel.closed).rejects.toThrow();
      if (origin === "owner_signal") {
        controller.abort(failure);
      } else if (origin === "caller_close") {
        channel.close();
      } else {
        expect(() => progress("invalid frame")).toThrow();
      }
      await rejected;
    }
    expect(observation.info).toHaveBeenCalledOnce();
    expect(observation.info).toHaveBeenCalledWith("node duplex invocation closed", {
      nodeId: "node-test",
      invokeId: "invoke-test",
      origin,
      outcome: origin === "invocation_resolved" ? "resolved" : "rejected",
      framedReady: true,
      openedAtMs: expect.any(Number),
      lifetimeMs: expect.any(Number),
      ...(origin === "invocation_resolved" ? {} : { rejectionCategory: "local_error" }),
    });
    expect(JSON.stringify(observation.info.mock.calls)).not.toContain(privateText);
  } finally {
    channel.close();
    settle();
    await channel.closed.catch(() => {});
  }
});

it("fences node credential frames when retained authority closes without aborting its caller", async () => {
  observation.info.mockClear();
  const nodeRegistry = new NodeRegistry();
  const send = vi.spyOn(nodeRegistry, "sendInvokeInput").mockImplementation(() => {});
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("credential authority retired");
    }
  };
  const invoke = vi.fn<Parameters<typeof openOwnedGatewayNodeDuplex>[0]["invokeNode"]>(
    async (params, stream, signal) => {
      expect(params).not.toHaveProperty("assertCurrent");
      stream?.onDispatchReady?.("credential-invoke");
      stream?.onProgress(JSON.stringify({ v: 1, kind: "ready" }));
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { complete: true };
    },
  );
  const caller = new AbortController();
  const channel = await openOwnedGatewayNodeDuplex({
    params: { nodeId: "node", command: "codex.exec-server.stdio.v1", assertCurrent },
    context: { nodeRegistry },
    invokeNode: invoke,
    signal: caller.signal,
    assertCurrent: () => {},
  });
  try {
    await channel.send(Uint8Array.of(1));
    expect(send).toHaveBeenCalledOnce();
    current = false;
    await expect(channel.send(Uint8Array.of(2))).rejects.toThrow("credential authority retired");
    expect(caller.signal.aborted).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    await expect(channel.closed).rejects.toThrow("node duplex channel is closed");
    expect(observation.info).toHaveBeenCalledWith(
      "node duplex invocation closed",
      expect.objectContaining({ origin: "authority_check", outcome: "rejected" }),
    );
  } finally {
    channel.close();
    await channel.closed.catch(() => {});
    send.mockRestore();
  }
});
