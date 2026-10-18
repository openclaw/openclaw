import { describe, expect, it, vi } from "vitest";
import {
  getWorkerMessageMetrics,
  recordWorkerMessage,
  observeWorkerMessage,
} from "./worker-message-metrics.js";

// Vitest runs this contract in a worker; model the Gateway's main endpoint.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));

describe("worker message metrics", () => {
  it.each(["other", "lifecycle"] as const)(
    "attributes resource close requests through %s transport",
    (transport) => {
      const before = getWorkerMessageMetrics().find(
        (row) => row.kind === "resource" && row.direction === "to_worker",
      );
      const request = { closeResource: true, key: "fixture" };
      observeWorkerMessage(
        transport === "lifecycle" ? { type: "post", value: request } : request,
        "to_worker",
        transport,
      );
      expect(getWorkerMessageMetrics()).toContainEqual({
        kind: "resource",
        direction: "to_worker",
        messages: (before?.messages ?? 0) + 1,
        payloadBytes: before?.payloadBytes ?? 0,
        unmeasuredMessages: (before?.unmeasuredMessages ?? 0) + 1,
      });
    },
  );

  it("counts both serialized payloads in SQLite open requests", () => {
    const before = getWorkerMessageMetrics().find(
      (row) => row.kind === "sqlite_request" && row.direction === "to_worker",
    );
    observeWorkerMessage(
      { type: "open", actor: 1, input: new Uint8Array(8), preparation: new Uint8Array(1024) },
      "to_worker",
    );
    expect(getWorkerMessageMetrics()).toContainEqual({
      kind: "sqlite_request",
      direction: "to_worker",
      messages: (before?.messages ?? 0) + 1,
      payloadBytes: (before?.payloadBytes ?? 0) + 1032,
      unmeasuredMessages: before?.unmeasuredMessages ?? 0,
    });
  });

  it("measures encoded reply payloads instead of SQLite continuation metadata", () => {
    const before = getWorkerMessageMetrics().find(
      (row) => row.kind === "sqlite_reply" && row.direction === "from_worker",
    );
    observeWorkerMessage(
      {
        type: "message",
        id: 1,
        value: { id: 2, ok: true, input: "next", value: new Uint8Array(32) },
      },
      "from_worker",
      "lifecycle",
    );
    expect(getWorkerMessageMetrics()).toContainEqual({
      kind: "sqlite_reply",
      direction: "from_worker",
      messages: (before?.messages ?? 0) + 1,
      payloadBytes: (before?.payloadBytes ?? 0) + 32,
      unmeasuredMessages: before?.unmeasuredMessages ?? 0,
    });
  });

  it("separates directions and unknown sizes from measured empty payloads", () => {
    const before = getWorkerMessageMetrics();
    const requests = before.find(
      (row) => row.kind === "sqlite_request" && row.direction === "to_worker",
    );
    const replies = before.find(
      (row) => row.kind === "sqlite_reply" && row.direction === "from_worker",
    );
    recordWorkerMessage("sqlite_request", "to_worker", 120);
    recordWorkerMessage("sqlite_request", "to_worker", 0);
    recordWorkerMessage("sqlite_reply", "from_worker", 240);
    recordWorkerMessage("sqlite_reply", "from_worker");
    const snapshot = getWorkerMessageMetrics();
    const expectedRequests = {
      kind: "sqlite_request",
      direction: "to_worker",
      messages: (requests?.messages ?? 0) + 2,
      payloadBytes: (requests?.payloadBytes ?? 0) + 120,
      unmeasuredMessages: requests?.unmeasuredMessages ?? 0,
    };
    const expectedReplies = {
      kind: "sqlite_reply",
      direction: "from_worker",
      messages: (replies?.messages ?? 0) + 2,
      payloadBytes: (replies?.payloadBytes ?? 0) + 240,
      unmeasuredMessages: (replies?.unmeasuredMessages ?? 0) + 1,
    };
    expect(snapshot).toEqual(expect.arrayContaining([expectedRequests, expectedReplies]));
    recordWorkerMessage("sqlite_reply", "from_worker", 60);
    expect(snapshot).toEqual(expect.arrayContaining([expectedReplies]));
    expect(getWorkerMessageMetrics()).toEqual(
      expect.arrayContaining([
        {
          ...expectedReplies,
          messages: expectedReplies.messages + 1,
          payloadBytes: expectedReplies.payloadBytes + 60,
        },
      ]),
    );
  });
});
