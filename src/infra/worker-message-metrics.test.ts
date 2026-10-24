import { describe, expect, it, vi } from "vitest";
import {
  getWorkerMessageMetrics,
  recordWorkerMessage,
  observeWorkerMessage,
  type WorkerMessageKind,
  type WorkerMessageDirection,
} from "./worker-message-metrics.js";

// Vitest runs this contract in a worker; model the Gateway's main endpoint.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

function increment(kind: WorkerMessageKind, direction: WorkerMessageDirection) {
  const before = getWorkerMessageMetrics().find(
    (row) => row.kind === kind && row.direction === direction,
  );
  return (messages: number, payloadBytes: number, unmeasuredMessages = 0) => ({
    kind,
    direction,
    messages: (before?.messages ?? 0) + messages,
    payloadBytes: (before?.payloadBytes ?? 0) + payloadBytes,
    unmeasuredMessages: (before?.unmeasuredMessages ?? 0) + unmeasuredMessages,
  });
}

describe("worker message metrics", () => {
  it.each(["other", "lifecycle"] as const)(
    "attributes resource close requests through %s transport",
    (transport) => {
      const expected = increment("resource", "to_worker");
      const request = { closeResource: true, key: "fixture" };
      observeWorkerMessage(
        transport === "lifecycle" ? { type: "post", value: request } : request,
        "to_worker",
        transport,
      );
      expect(getWorkerMessageMetrics()).toContainEqual(expected(1, 0, 1));
    },
  );

  it("counts both serialized payloads in SQLite open requests", () => {
    const expected = increment("sqlite_request", "to_worker");
    observeWorkerMessage(
      { type: "open", actor: 1, input: new Uint8Array(8), preparation: new Uint8Array(1024) },
      "to_worker",
    );
    expect(getWorkerMessageMetrics()).toContainEqual(expected(1, 1032));
  });

  it("measures encoded reply payloads instead of SQLite continuation metadata", () => {
    const expected = increment("sqlite_reply", "from_worker");
    observeWorkerMessage(
      {
        type: "message",
        id: 1,
        value: { id: 2, ok: true, input: "next", value: new Uint8Array(32) },
      },
      "from_worker",
      "lifecycle",
    );
    expect(getWorkerMessageMetrics()).toContainEqual(expected(1, 32));
  });

  it("separates directions and unknown sizes from measured empty payloads", () => {
    const requests = increment("sqlite_request", "to_worker");
    const replies = increment("sqlite_reply", "from_worker");
    recordWorkerMessage("sqlite_request", "to_worker", 120);
    recordWorkerMessage("sqlite_request", "to_worker", 0);
    recordWorkerMessage("sqlite_reply", "from_worker", 240);
    recordWorkerMessage("sqlite_reply", "from_worker");
    const snapshot = getWorkerMessageMetrics();
    const expectedRequests = requests(2, 120);
    const expectedReplies = replies(2, 240, 1);
    expect(snapshot).toEqual(expect.arrayContaining([expectedRequests, expectedReplies]));
    recordWorkerMessage("sqlite_reply", "from_worker", 60);
    expect(snapshot).toEqual(expect.arrayContaining([expectedReplies]));
    expect(getWorkerMessageMetrics()).toContainEqual(replies(3, 300, 1));
  });
});
