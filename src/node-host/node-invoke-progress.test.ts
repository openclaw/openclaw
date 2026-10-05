import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { NodeHostClient } from "./client.js";
import { createNodeInvokeProgressWriter } from "./node-invoke-progress.js";

const observation = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ info: observation }),
}));

const frame = {
  id: "invoke-1",
  nodeId: "node-1",
  command: "test.duplex",
  paramsJSON: null,
  timeoutMs: 0,
  idempotencyKey: null,
};

describe("node invoke progress writer", () => {
  it.each([false, true])(
    "reports only wire-sent progress when request failure is %s",
    async (fails) => {
      observation.mockReset();
      const onError = vi.fn();
      const request = vi.fn<NodeHostClient["request"]>(async (method, _payload, options) => {
        if (method === "node.invoke.progress" && fails) {
          options?.onSent?.("failed-wire-id");
          throw new Error("private-transport-error");
        }
        // The invocation client suppresses late requests without calling onSent.
        return {};
      });
      const writer = createNodeInvokeProgressWriter({
        client: { request },
        frame,
        idleTimeoutMs: 30_000,
        onError,
      });
      await writer.write("private-output");
      writer.stop();
      await writer.flush();
      expect(onError).toHaveBeenCalledTimes(fails ? 1 : 0);
      expect(observation).toHaveBeenCalledWith(
        "node invoke progress state",
        expect.objectContaining({
          stage: "settled",
          lastSentSeq: fails ? 0 : null,
          lastCompletedSeq: null,
          requestFailed: fails,
          progressRequestId: fails ? "failed-wire-id" : null,
        }),
      );
      expect(JSON.stringify(observation.mock.calls)).not.toContain("private");
    },
  );
  it("coalesces safe diagnostics independently of a stalled data request and diagnostic failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    observation.mockReset();
    const progress = createDeferred<Record<string, unknown>>();
    const diagnostic = createDeferred<Record<string, unknown>>();
    const request = vi.fn<NodeHostClient["request"]>();
    let firstProgress = true;
    let firstDiagnostic = true;
    request.mockImplementation((method, _payload, options) => {
      if (method === "node.invoke.progress") {
        options?.onSent?.("progress-wire-id");
        if (firstProgress) {
          firstProgress = false;
          return progress.promise;
        }
      } else if (firstDiagnostic) {
        firstDiagnostic = false;
        return diagnostic.promise;
      }
      return Promise.resolve({});
    });
    const onError = vi.fn();
    const writer = createNodeInvokeProgressWriter({
      client: { request },
      frame: { ...frame, command: "private-command", paramsJSON: "private-token" },
      idleTimeoutMs: 30_000,
      onError,
    });
    try {
      writer.startHeartbeats();
      const writing = writer.write("private-output");
      await vi.advanceTimersByTimeAsync(5_000);
      void writer.write("private-more-output");
      expect(
        request.mock.calls.filter(([method]) => method === "node.invoke.progress"),
      ).toHaveLength(1);
      expect(request.mock.calls.filter(([method]) => method === "node.event")).toHaveLength(1);
      expect(observation).toHaveBeenCalledWith(
        "node invoke progress state",
        expect.objectContaining({
          pendingSeq: 0,
          lastSentSeq: 0,
          lastCompletedSeq: null,
          sourceWrites: 1,
          stage: "sample",
        }),
      );
      diagnostic.reject(new Error("private-diagnostic-error"));
      progress.resolve({});
      await writing;
      writer.stop("owner_aborted");
      await writer.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).not.toHaveBeenCalled();
      expect(
        request.mock.calls.filter(([method]) => method === "node.invoke.progress"),
      ).toHaveLength(3);
      const metadata = request.mock.calls
        .filter(([method]) => method === "node.event")
        .map(([, params]) => params);
      expect(JSON.stringify(metadata)).not.toContain("private");
      expect(JSON.stringify(observation.mock.calls)).not.toContain("private");
      expect(observation.mock.calls.filter(([, fields]) => fields.stage === "sample")).toHaveLength(
        2,
      );
      expect(observation).toHaveBeenCalledWith(
        "node invoke progress state",
        expect.objectContaining({
          stage: "settled",
          pendingSeq: null,
          disposition: "owner_aborted",
          sourceWrites: 2,
        }),
      );
    } finally {
      progress.resolve({});
      diagnostic.resolve({});
      writer.stop();
      await writer.flush();
      vi.useRealTimers();
    }
  });
  it("chunks output to 16 KiB", async () => {
    const request = vi.fn(async () => ({}));
    const client = { request } as NodeHostClient;
    const writer = createNodeInvokeProgressWriter({
      client,
      frame,
      idleTimeoutMs: 30_000,
      onError: vi.fn(),
    });

    await writer.write("é".repeat(10_000));
    const progressCalls = request.mock.calls.filter(
      ([method]) => method === "node.invoke.progress",
    );
    expect(progressCalls).toHaveLength(2);
    for (const [, params] of progressCalls as unknown as Array<[string, { chunk: string }]>) {
      expect(Buffer.byteLength(params.chunk, "utf8")).toBeLessThanOrEqual(16 * 1024);
    }
  });

  it.each([
    { idleTimeoutMs: 100, heartbeatIntervalMs: 250 },
    { idleTimeoutMs: 2_000, heartbeatIntervalMs: 1_000 },
    { idleTimeoutMs: 60_000, heartbeatIntervalMs: 5_000 },
  ])(
    "emits idle heartbeats every $heartbeatIntervalMs ms for a $idleTimeoutMs ms timeout",
    async ({ idleTimeoutMs, heartbeatIntervalMs }) => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const request = vi.fn(async () => ({}));
        const writer = createNodeInvokeProgressWriter({
          client: { request } as NodeHostClient,
          frame,
          idleTimeoutMs,
          onError: vi.fn(),
        });
        writer.startHeartbeats();
        await vi.advanceTimersByTimeAsync(heartbeatIntervalMs - 1);
        expect(
          request.mock.calls.filter(([method]) => method === "node.invoke.progress"),
        ).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(request).toHaveBeenCalledWith(
          "node.invoke.progress",
          {
            invokeId: "invoke-1",
            nodeId: "node-1",
            seq: 0,
            chunk: "",
          },
          expect.objectContaining({ onSent: expect.any(Function) }),
        );
        writer.stop();
        await writer.flush();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
