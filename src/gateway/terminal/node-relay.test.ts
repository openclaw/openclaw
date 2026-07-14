import { describe, expect, it, vi } from "vitest";
import type { NodeInvokeResult, NodeRegistry } from "../node-registry.js";
import { createNodeRelayBackend } from "./node-relay.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("createNodeRelayBackend", () => {
  it("relays progress, input, resize, cancellation, and the node exit result", async () => {
    const invokeResult = deferred<NodeInvokeResult>();
    let onProgress: ((chunk: string) => void) | undefined;
    let signal: AbortSignal | undefined;
    const sendInvokeInput = vi.fn();
    const registry = {
      invoke: vi.fn(
        (params: {
          onInvokeId?: (id: string) => void;
          onProgress?: (chunk: string) => void;
          signal?: AbortSignal;
        }) => {
          onProgress = params.onProgress;
          signal = params.signal;
          params.onInvokeId?.("invoke-1");
          return invokeResult.promise;
        },
      ),
      sendInvokeInput,
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      nodeId: "node-1",
      command: "codex.terminal.resume.v1",
      params: { threadId: "thread" },
    });
    const data = vi.fn();
    const exit = vi.fn();
    backend.onData(data);
    backend.onExit(exit);

    onProgress?.("");
    onProgress?.("hello");
    expect(data).toHaveBeenCalledWith("hello");
    backend.write("keys");
    backend.resize(100, 30);
    expect(sendInvokeInput).toHaveBeenNthCalledWith(1, "invoke-1", {
      kind: "data",
      data: "keys",
    });
    expect(sendInvokeInput).toHaveBeenNthCalledWith(2, "invoke-1", {
      kind: "resize",
      cols: 100,
      rows: 30,
    });

    invokeResult.resolve({ ok: true, payloadJSON: JSON.stringify({ exitCode: 7, signal: 15 }) });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith({ exitCode: 7, signal: 15 }));

    backend.kill();
    expect(signal?.aborted).toBe(true);
  });

  it("maps node disconnect failures to terminal errors", async () => {
    const registry = {
      invoke: vi.fn((params: { onInvokeId?: (id: string) => void }) => {
        params.onInvokeId?.("invoke-2");
        return Promise.resolve({
          ok: false,
          error: { code: "NOT_CONNECTED", message: "node disconnected" },
        });
      }),
      sendInvokeInput: vi.fn(),
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      nodeId: "node-1",
      command: "anthropic.claude.terminal.resume.v1",
      params: {},
    });
    const exit = vi.fn();
    backend.onExit(exit);
    await vi.waitFor(() =>
      expect(exit).toHaveBeenCalledWith({ error: "NOT_CONNECTED: node disconnected" }),
    );
  });
});
