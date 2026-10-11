import type { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "../../packages/gateway-client/src/websocket.test-support.js";
import {
  type WorkerConnectParams,
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createWorkerConnection } from "./worker-connection.js";

function createGatewayToolConnectionFixture(
  connectParams: WorkerConnectParams,
  heartbeatIntervalMs = 60_000,
) {
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
                  policy: { heartbeatIntervalMs, maxPayload: 25 * 1024 * 1024 },
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
  return {
    connection,
    sent,
    sockets,
    respond: (id: string, payload: unknown) =>
      sockets
        .at(-1)!
        .emit("message", Buffer.from(JSON.stringify({ type: "res", id, ok: true, payload }))),
  };
}

export function registerWorkerGatewayToolTransportTests(connectParams: WorkerConnectParams) {
  describe("WorkerConnection exec approval transport", () => {
    it("routes registration and a human-paced decision over the admitted connection", async () => {
      vi.useFakeTimers();
      const { connection, sent, respond } = createGatewayToolConnectionFixture(
        connectParams,
        3_600_000,
      );
      try {
        await connection.start();
        const params = { id: "approval-1", command: "hostname", toolCallId: "exec-1" };
        const request = connection.requestExecApproval(params);
        expect(sent[0]).toMatchObject({ method: "worker.exec.approval.request", params });
        const registration = { id: params.id, expiresAtMs: Date.now() + 1_800_000 };
        respond(sent[0]!.id, registration);
        await expect(request).resolves.toMatchObject({ ok: true, payload: registration });
        const decision = connection.requestExecApprovalDecision({ id: params.id });
        expect(sent[1]).toMatchObject({
          method: "worker.exec.approval.waitDecision",
          params: { id: params.id },
        });
        let settled = false;
        void decision.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(1_799_000);
        expect(settled).toBe(false);
        respond(sent[1]!.id, { decision: "allow-once" });
        await expect(decision).resolves.toMatchObject({
          ok: true,
          payload: { decision: "allow-once" },
        });
      } finally {
        await connection.stop();
        vi.useRealTimers();
      }
    });

    it("invalidates captured exec authority across disconnect and readmission", async () => {
      vi.useFakeTimers();
      const { connection, sockets } = createGatewayToolConnectionFixture(connectParams);
      try {
        expect(() => connection.captureExecApprovalAuthority()).toThrow("lost Gateway admission");
        await connection.start();
        const assertCurrent = connection.captureExecApprovalAuthority();
        expect(assertCurrent).not.toThrow();
        sockets[0]!.emit("close", 1006, Buffer.alloc(0));
        expect(assertCurrent).toThrow("lost Gateway admission");
        await vi.advanceTimersByTimeAsync(10);
        expect(connection.state.kind).toBe("ready");
        expect(assertCurrent).toThrow("lost Gateway admission");
        const assertReadmitted = connection.captureExecApprovalAuthority();
        expect(assertReadmitted).not.toThrow();
        await connection.stop();
        expect(assertReadmitted).toThrow("lost Gateway admission");
      } finally {
        await connection.stop();
        vi.useRealTimers();
      }
    });

    it("fails closed without replay when the approval connection is interrupted", async () => {
      vi.useFakeTimers();
      const { connection, sent, sockets } = createGatewayToolConnectionFixture(connectParams);
      try {
        await connection.start();
        const decision = connection.requestExecApprovalDecision({ id: "approval-1" });
        const rejected = expect(decision).rejects.toThrow("interrupted");
        sockets[0]!.emit("close", 1006, Buffer.alloc(0));
        await rejected;
        await vi.advanceTimersByTimeAsync(10);
        expect(
          sent.filter((frame) => frame.method === "worker.exec.approval.waitDecision"),
        ).toHaveLength(1);
      } finally {
        await connection.stop();
        vi.useRealTimers();
      }
    });
  });

  describe("WorkerConnection Gateway tool transport", () => {
    it("queues excess calls in order while queued aborts and control traffic remain independent", async () => {
      vi.useFakeTimers();
      const { connection, sent, respond } = createGatewayToolConnectionFixture(
        connectParams,
        1_000,
      );
      const queuedAbort = new AbortController();
      const calls: ReturnType<typeof connection.invokeGatewayTool>[] = [];
      try {
        const starting = connection.start();
        await vi.advanceTimersByTimeAsync(0);
        await starting;
        for (let index = 0; index < 7; index += 1) {
          calls.push(
            connection.invokeGatewayTool(
              {
                generation: "surface",
                toolId: "tool",
                toolCallId: `call-${index}`,
                arguments: {},
              },
              index === 5 ? { signal: queuedAbort.signal } : {},
            ),
          );
        }
        const settled = Promise.allSettled(calls);
        const invocations = () =>
          sent.filter((frame) => frame.method === "worker.gatewayTool.invoke");
        await vi.advanceTimersByTimeAsync(0);
        expect(invocations()).toMatchObject([
          { params: { toolCallId: "call-0" } },
          { params: { toolCallId: "call-1" } },
          { params: { toolCallId: "call-2" } },
          { params: { toolCallId: "call-3" } },
        ]);

        queuedAbort.abort(new Error("queued call cancelled"));
        const cancellation = connection.cancelGatewayTool({
          generation: "surface",
          toolCallId: "call-0",
        });
        await vi.advanceTimersByTimeAsync(1_000);
        const cancelFrame = sent.find((frame) => frame.method === "worker.gatewayTool.cancel");
        const heartbeat = sent.find((frame) => frame.method === "worker.heartbeat");
        expect(cancelFrame).toBeDefined();
        expect(heartbeat).toBeDefined();
        expect(invocations()).toHaveLength(4);
        respond(cancelFrame!.id, { cancelled: true });
        respond(heartbeat!.id, {
          receivedAtMs: Date.now(),
          status: "ok",
          ownerEpoch: connectParams.admission.ownerEpoch,
        });
        await expect(cancellation).resolves.toMatchObject({ ok: true });

        respond(invocations()[2]!.id, { content: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(invocations()).toHaveLength(5);
        expect(invocations()[4]).toMatchObject({ params: { toolCallId: "call-4" } });

        respond(invocations()[0]!.id, { content: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(invocations()).toHaveLength(6);
        expect(invocations()[5]).toMatchObject({ params: { toolCallId: "call-6" } });
        for (const index of [1, 3, 4, 5]) {
          respond(invocations()[index]!.id, { content: [] });
        }
        const outcomes = await settled;
        expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(6);
        expect(outcomes[5]).toMatchObject({
          status: "rejected",
          reason: { name: "AbortError", cause: new Error("queued call cancelled") },
        });
        expect(connection.state.kind).toBe("ready");
      } finally {
        await connection.stop();
        await Promise.allSettled(calls);
        vi.useRealTimers();
      }
    });

    it.each([false, true])(
      "preserves replay and cancellation across reconnect (aborted=%s)",
      async (abortDuringReconnect) => {
        vi.useFakeTimers();
        const { connection, sent, sockets, respond } =
          createGatewayToolConnectionFixture(connectParams);
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
          await vi.advanceTimersByTimeAsync(0);
          expect(sent).toEqual([
            expect.objectContaining({ method: "worker.gatewayTool.invoke", params: args }),
          ]);
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
          respond(sent[2]!.id, { cancelled: true });
          await expect(cancel).resolves.toMatchObject({ ok: true, payload: { cancelled: true } });
          respond(sent[1]!.id, { content: [{ type: "text", text: "done" }] });
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
