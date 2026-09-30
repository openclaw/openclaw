import type { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import {
  type WorkerConnectParams,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createWorkerConnection } from "./worker-connection.js";

export function registerWorkerGatewayToolTransportTests(connectParams: WorkerConnectParams) {
  describe("WorkerConnection Gateway tool transport", () => {
    it.each([false, true])(
      "preserves replay and cancellation across reconnect (aborted=%s)",
      async (abortDuringReconnect) => {
        vi.useFakeTimers();
        const sent: Array<{ id: string; method: string; params: unknown }> = [];
        const sockets: Array<EventEmitter> = [];
        const connection = createWorkerConnection({
          endpoint: { kind: "unix", socketPath: "/tmp/worker-gateway-tools-test.sock" },
          connectParams,
          reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
          createSocket: () => {
            // ws exposes its unconnected server constructor at runtime, but its types expose clients only.
            const socket: unknown = Reflect.construct(WebSocket, [null, undefined, {}]);
            if (!(socket instanceof WebSocket)) {
              throw new Error("Expected a WebSocket fixture");
            }
            Object.defineProperty(socket, "readyState", { value: WebSocket.OPEN });
            vi.spyOn(socket, "send").mockImplementation((data, optionsOrCallback, done) => {
              const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : done;
              if (typeof data !== "string") {
                throw new Error("Expected an encoded worker request");
              }
              const frame = JSON.parse(data);
              if (frame.method === "connect") {
                socket.emit(
                  "message",
                  Buffer.from(
                    JSON.stringify({
                      type: "res",
                      id: frame.id,
                      ok: true,
                      payload: {
                        type: "worker-hello-ok",
                        environmentId: connectParams.admission.environmentId,
                        sessionId: connectParams.admission.sessionId,
                        ownerEpoch: 1,
                        rpcSetVersion: WORKER_RPC_SET_VERSION,
                        protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
                        credentialExpiresAtMs: Date.now() + 60_000,
                        policy: { heartbeatIntervalMs: 60_000, maxPayload: 25 * 1024 * 1024 },
                      },
                    }),
                  ),
                );
              } else {
                sent.push(frame);
              }
              callback?.();
            });
            vi.spyOn(socket, "close").mockImplementation(() => {
              socket.emit("close", 1000, Buffer.alloc(0));
            });
            vi.spyOn(socket, "terminate").mockImplementation(() => {
              socket.emit("close", 1006, Buffer.alloc(0));
            });
            sockets.push(socket);
            queueMicrotask(() => socket.emit("open"));
            return socket;
          },
        });
        try {
          const starting = connection.start();
          await vi.advanceTimersByTimeAsync(0);
          expect(connection.state.kind).toBe("ready");
          await starting;
          const args = {
            generation: "surface",
            toolId: "tool",
            toolCallId: "call",
            arguments: { task: "child" },
          };
          const updates: unknown[] = [];
          const controller = new AbortController();
          const pending = connection.invokeGatewayTool(args, {
            replay: true,
            signal: controller.signal,
            onUpdate: (result) => updates.push(result),
          });
          const update = (socket: EventEmitter, seq: number, generation = args.generation) =>
            socket.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  type: "event",
                  event: "worker.gatewayTool.update",
                  payload: {
                    generation,
                    toolCallId: args.toolCallId,
                    seq,
                    result: { content: [{ type: "text", text: `update-${seq}` }] },
                  },
                }),
              ),
            );
          update(sockets[0]!, 1);
          sockets[0]!.emit("close", 1012, Buffer.from("gateway-unavailable"));
          if (abortDuringReconnect) {
            const rejected = expect(pending).rejects.toThrow();
            controller.abort(new Error("cancelled during reconnect"));
            const cancelled = connection.cancelGatewayTool({
              generation: args.generation,
              toolCallId: args.toolCallId,
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(sent.map((frame) => frame.method)).toEqual([
              "worker.gatewayTool.invoke",
              "worker.gatewayTool.cancel",
            ]);
            sockets[1]!.emit(
              "message",
              Buffer.from(
                JSON.stringify({
                  type: "res",
                  id: sent[1]!.id,
                  ok: true,
                  payload: { cancelled: true },
                }),
              ),
            );
            await expect(cancelled).resolves.toMatchObject({ ok: true });
            await rejected;
            expect(
              sent.filter((frame) => frame.method === "worker.gatewayTool.invoke"),
            ).toHaveLength(1);
            return;
          }
          await vi.advanceTimersByTimeAsync(0);
          expect(sent.map((frame) => frame.params)).toEqual([args, args]);
          update(sockets[1]!, 1);
          update(sockets[1]!, 2, "old-surface");
          update(sockets[1]!, 2);
          const cancel = connection.cancelGatewayTool({
            generation: args.generation,
            toolCallId: args.toolCallId,
          });
          const response = (id: string, payload: unknown) =>
            sockets[1]!.emit(
              "message",
              Buffer.from(JSON.stringify({ type: "res", id, ok: true, payload })),
            );
          response(sent[2]!.id, { cancelled: true });
          await expect(cancel).resolves.toMatchObject({ ok: true, payload: { cancelled: true } });
          response(sent[1]!.id, { content: [{ type: "text", text: "done" }] });
          await expect(pending).resolves.toMatchObject({
            ok: true,
            payload: { content: [{ type: "text", text: "done" }] },
          });
          expect(updates).toEqual([
            { content: [{ type: "text", text: "update-1" }] },
            { content: [{ type: "text", text: "update-2" }] },
          ]);
        } finally {
          await connection.stop();
          vi.useRealTimers();
        }
      },
    );
  });
}
