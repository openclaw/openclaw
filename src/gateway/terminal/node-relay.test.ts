import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS } from "../../infra/node-commands.js";
import { type NodeInvokeResult, NodeRegistry } from "../node-registry.js";
import { createNodeRelayBackend } from "./node-relay.js";
import { TerminalSessionManager } from "./session-manager.js";
import { baseOpenRequest, expectTerminalOpen } from "./session-manager.test-helpers.js";

function registerNodeRelayClient(registry: NodeRegistry) {
  const frames: string[] = [];
  registry.register(
    {
      connId: "conn-validated",
      usesSharedGatewayAuth: false,
      socket: {
        readyState: WebSocket.OPEN,
        bufferedAmount: 0,
        send: (frame) => frames.push(frame),
        close: vi.fn(),
        terminate: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
      },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: {
          id: GATEWAY_CLIENT_IDS.NODE_HOST,
          version: "1.0.0",
          platform: "linux",
          mode: "node",
        },
        device: {
          id: "node-validated",
          publicKey: "public-key",
          signature: "signature",
          signedAt: 1,
          nonce: "nonce",
        },
        commands: ["codex.terminal.resume.v1"],
      },
    },
    { pairingIdentity: "identity-a", pairingGeneration: "generation-a" },
  );
  return frames;
}

describe("createNodeRelayBackend", () => {
  it("waits for pairing validation and dispatch instead of the final node exit", async () => {
    const pairingState = createDeferred<{ identity: string; generation: string }>();
    const resolveCurrentPairingState = vi.fn(async () => await pairingState.promise);
    const registry = new NodeRegistry({
      resolveCurrentPairingState,
    });
    const frames = registerNodeRelayClient(registry);

    const opening = createNodeRelayBackend({
      registry,
      isDispatchAuthorized: () => true,
      nodeId: "node-validated",
      expectedConnId: "conn-validated",
      expectedPairingGeneration: "generation-a",
      command: "codex.terminal.resume.v1",
      params: { threadId: "thread" },
    });
    await vi.waitFor(() =>
      expect(resolveCurrentPairingState).toHaveBeenCalledWith("node-validated"),
    );
    expect(frames).toEqual([]);

    pairingState.resolve({ identity: "identity-a", generation: "generation-a" });
    const backend = await withTestTimeout(
      opening,
      500,
      "timed out waiting for node terminal dispatch readiness",
    );

    expect(JSON.parse(frames[0] ?? "{}")).toMatchObject({
      event: "node.invoke.request",
      payload: {
        nodeId: "node-validated",
        command: "codex.terminal.resume.v1",
      },
    });
    backend.kill();
    registry.unregister("conn-validated");
  });

  it.each([false, true])(
    "bounds a silent node terminal and renews on an empty heartbeat (heartbeat: %s)",
    async (heartbeat) => {
      vi.useFakeTimers();
      const registry = new NodeRegistry();
      const frames = registerNodeRelayClient(registry);
      try {
        const emit = vi.fn();
        const manager = new TerminalSessionManager({ emit });
        const opened = expectTerminalOpen(
          await manager.open(
            baseOpenRequest({
              owner: { kind: "conn", connId: "operator-silent" },
              createBackend: () =>
                createNodeRelayBackend({
                  registry,
                  isDispatchAuthorized: () => true,
                  nodeId: "node-validated",
                  expectedConnId: "conn-validated",
                  expectedPairingGeneration: "generation-a",
                  command: "codex.terminal.resume.v1",
                  params: {},
                }),
            }),
          ),
        );
        const request = JSON.parse(frames[0] ?? "{}") as { payload: { id: string } };
        const progress = {
          invokeId: request.payload.id,
          nodeId: "node-validated",
          connId: "conn-validated",
        };
        const exitEvents = () => emit.mock.calls.filter(([, event]) => event === "terminal.exit");
        const cancellations = () =>
          frames
            .map((frame) => JSON.parse(frame) as { event?: string })
            .filter((frame) => frame.event === "node.invoke.cancel");
        expect(manager.size).toBe(1);
        await vi.advanceTimersByTimeAsync(NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS - 1);
        expect(exitEvents()).toEqual([]);
        if (heartbeat) {
          expect(registry.handleInvokeProgress({ ...progress, seq: 0, chunk: "" })).toBe(true);
          await vi.advanceTimersByTimeAsync(NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS - 1);
          expect(exitEvents()).toEqual([]);
        }
        await vi.advanceTimersByTimeAsync(1);
        expect(exitEvents()).toEqual([
          [
            "operator-silent",
            "terminal.exit",
            {
              sessionId: opened.sessionId,
              exitCode: null,
              signal: null,
              reason: "error",
              error: "IDLE_TIMEOUT: node invoke produced no progress",
            },
          ],
        ]);
        expect(manager.size).toBe(0);
        expect(cancellations()).toHaveLength(1);
        expect(registry.handleInvokeProgress({ ...progress, seq: 1, chunk: "late" })).toBe(false);
        await vi.advanceTimersByTimeAsync(NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS);
        expect(exitEvents()).toHaveLength(1);
        expect(cancellations()).toHaveLength(1);
      } finally {
        registry.unregister("conn-validated");
        vi.useRealTimers();
      }
    },
  );

  it.each(["result", "abort", "disconnect", "send-failure"] as const)(
    "clears the first-heartbeat timer on %s before any progress",
    async (settlement) => {
      vi.useFakeTimers();
      const registry = new NodeRegistry();
      const frames = registerNodeRelayClient(registry);
      try {
        const baselineTimers = vi.getTimerCount();
        if (settlement === "send-failure") {
          const node = registry.get("node-validated");
          if (!node) {
            throw new Error("expected registered node");
          }
          vi.spyOn(node.client.socket, "send").mockImplementation(() => {
            throw new Error("transport failed");
          });
        }
        const opening = createNodeRelayBackend({
          registry,
          isDispatchAuthorized: () => true,
          nodeId: "node-validated",
          expectedConnId: "conn-validated",
          expectedPairingGeneration: "generation-a",
          command: "codex.terminal.resume.v1",
          params: {},
        });
        if (settlement === "send-failure") {
          await expect(opening).rejects.toThrow("UNAVAILABLE: failed to send invoke to node");
          expect(vi.getTimerCount()).toBe(baselineTimers);
          return;
        }
        const backend = await opening;
        const exit = vi.fn();
        backend.onExit(exit);
        expect(vi.getTimerCount()).toBe(baselineTimers + 1);
        if (settlement === "result") {
          const request = JSON.parse(frames[0] ?? "{}") as { payload: { id: string } };
          expect(
            registry.handleInvokeResult({
              id: request.payload.id,
              nodeId: "node-validated",
              connId: "conn-validated",
              ok: true,
              payload: { exitCode: 0 },
            }),
          ).toBe(true);
        } else if (settlement === "abort") {
          backend.kill();
        } else {
          registry.unregister("conn-validated");
        }
        expect(vi.getTimerCount()).toBe(baselineTimers);
        await vi.advanceTimersByTimeAsync(NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS);
        expect(exit).toHaveBeenCalledExactlyOnceWith(
          settlement === "result"
            ? { exitCode: 0 }
            : {
                error:
                  settlement === "abort"
                    ? "ABORTED: node invoke cancelled"
                    : "DISCONNECTED: node disconnected (codex.terminal.resume.v1)",
              },
        );
        expect(
          frames
            .map((frame) => JSON.parse(frame) as { event?: string })
            .filter((frame) => frame.event === "node.invoke.cancel"),
        ).toHaveLength(settlement === "abort" ? 1 : 0);
      } finally {
        registry.unregister("conn-validated");
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "codex.terminal.resume.v1",
    "codex.terminal.start.v1",
    "anthropic.claude.terminal.start.v1",
  ])("%s relays progress, input, resize, cancellation, and exit", async (command) => {
    const invokeResult = createDeferred<NodeInvokeResult>();
    let onProgress: ((chunk: string) => void) | undefined;
    let signal: AbortSignal | undefined;
    const sendInvokeInput = vi.fn();
    const registry = {
      invoke: vi.fn(
        (params: {
          onDispatchReady?: (id: string) => void;
          onProgress?: (chunk: string) => void;
          signal?: AbortSignal;
        }) => {
          onProgress = params.onProgress;
          signal = params.signal;
          params.onDispatchReady?.("invoke-1");
          return invokeResult.promise;
        },
      ),
      sendInvokeInput,
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      isDispatchAuthorized: () => true,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command,
      params: command.includes(".start.")
        ? { cwd: "/node/work", cols: 80, rows: 24 }
        : { threadId: "thread" },
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
      invoke: vi.fn((params: { onDispatchReady?: (id: string) => void }) => {
        params.onDispatchReady?.("invoke-2");
        return Promise.resolve({
          ok: false,
          error: { code: "NOT_CONNECTED", message: "node disconnected" },
        });
      }),
      sendInvokeInput: vi.fn(),
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      isDispatchAuthorized: () => true,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "anthropic.claude.terminal.resume.v1",
      params: {},
    });
    const exit = vi.fn();
    backend.onExit(exit);
    await vi.waitFor(() =>
      expect(exit).toHaveBeenCalledWith({ error: "NOT_CONNECTED: node disconnected" }),
    );
  });

  it("pins the expected connection and reports route changes through onExit", async () => {
    const invoke = vi.fn((params: { onDispatchReady?: (id: string) => void }) => {
      params.onDispatchReady?.("invoke-route-changed");
      return Promise.resolve({
        ok: false,
        error: { code: "ROUTE_CHANGED", message: "node connection changed before dispatch" },
      });
    });
    const registry = { invoke, sendInvokeInput: vi.fn() } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      isDispatchAuthorized: () => true,
      nodeId: "node-1",
      expectedConnId: "conn-authorized",
      expectedPairingGeneration: "generation-authorized",
      command: "codex.terminal.resume.v1",
      params: {},
    });
    const exit = vi.fn();
    backend.onExit(exit);

    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        expectedConnId: "conn-authorized",
        expectedPairingGeneration: "generation-authorized",
      }),
    );
    await vi.waitFor(() =>
      expect(exit).toHaveBeenCalledWith({
        error: "ROUTE_CHANGED: node connection changed before dispatch",
      }),
    );
  });

  it("bounds output buffered before onData registration", async () => {
    let onProgress: ((chunk: string) => void) | undefined;
    const registry = {
      invoke: vi.fn(
        (params: {
          onDispatchReady?: (id: string) => void;
          onProgress?: (chunk: string) => void;
        }) => {
          onProgress = params.onProgress;
          params.onDispatchReady?.("invoke-buffered");
          return Promise.resolve({ ok: true });
        },
      ),
      sendInvokeInput: vi.fn(),
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      isDispatchAuthorized: () => true,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "codex.terminal.resume.v1",
      params: {},
    });
    const chunkChars = 256 * 1024;
    onProgress?.("a".repeat(chunkChars));
    onProgress?.("b".repeat(chunkChars));
    onProgress?.("c".repeat(chunkChars));
    const data = vi.fn();

    backend.onData(data);

    expect(data.mock.calls.map(([chunk]) => chunk)).toEqual([
      "b".repeat(chunkChars),
      "c".repeat(chunkChars),
    ]);

    const surrogateBackend = await createNodeRelayBackend({
      registry,
      isDispatchAuthorized: () => true,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "codex.terminal.resume.v1",
      params: {},
    });
    const capChars = 512 * 1024;
    onProgress?.(`x😀${"y".repeat(capChars - 1)}`);
    const surrogateData = vi.fn();

    surrogateBackend.onData(surrogateData);

    expect(surrogateData).toHaveBeenCalledWith("y".repeat(capChars - 1));
  });

  it.each([
    ["a".repeat(2047), "😀b"],
    ["界".repeat(682), "界b"],
    [`\ud800x\udc00${"a".repeat(2041)}`, "a".repeat(7)],
    ["\0".repeat(2048), "\u001b[31m"],
  ])("preserves UTF-8-bounded input chunks %#", async (firstChunk, secondChunk) => {
    const sendInvokeInput = vi.fn();
    const registry = {
      invoke: vi.fn((params: { onDispatchReady?: (id: string) => void }) => {
        params.onDispatchReady?.("invoke-input");
        return Promise.resolve({ ok: true });
      }),
      sendInvokeInput,
    } as unknown as NodeRegistry;
    const backend = await createNodeRelayBackend({
      registry,
      isDispatchAuthorized: () => true,
      nodeId: "node-1",
      expectedConnId: "conn-1",
      command: "codex.terminal.resume.v1",
      params: {},
    });
    const expectedChunks = [firstChunk, secondChunk];
    const input = expectedChunks.join("");

    backend.write(input);

    const chunks = sendInvokeInput.mock.calls.map(
      (call) => (call[1] as { kind: "data"; data: string }).data,
    );
    expect(chunks.join("")).toBe(input);
    expect(chunks).toEqual(expectedChunks);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 2048)).toBe(true);
  });
});
