import { describe, expect, it, vi } from "vitest";
import {
  createChatAbortMarker,
  createChatRunState,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";

describe("createChatRunState", () => {
  it("replays complete prepared items and evicts raw and item siblings together", () => {
    const state = createChatRunState();
    let seq = 0;
    const send = (stream: string, data: Record<string, unknown>) => {
      state.recordProgressEvent("run", { runId: "run", stream, data, seq: ++seq, ts: seq });
    };
    send("item", {
      itemId: "preamble",
      kind: "preamble",
      phase: "end",
      status: "completed",
      title: "Status",
      progressText: "Ready",
    });
    send("item", {
      itemId: "preamble",
      kind: "preamble",
      phase: "update",
      status: "running",
      title: "Status",
      progressText: "Checking",
    });
    expect(state.runs.get("run")?.progressSnapshot?.events).toMatchObject([
      { data: { phase: "end", progressText: "Ready", title: "Status", status: "completed" } },
    ]);
    send("item", { itemId: "preamble", kind: "preamble", phase: "start", progressText: "" });
    expect(state.runs.get("run")?.progressSnapshot?.events).toEqual([]);
    for (let index = 0; index < 30; index += 1) {
      const toolCallId = `call-${index}`;
      send("tool", { toolCallId, name: "read", phase: "start", args: { path: "README.md" } });
      send("item", {
        itemId: `tool:${toolCallId}`,
        toolCallId,
        name: "read",
        kind: "tool",
        phase: "end",
        title: "Read file",
        status: "completed",
        extraTypedFact: "retained",
      });
    }
    const events = state.runs.get("run")?.progressSnapshot?.events ?? [];
    expect(events).toHaveLength(50);
    expect(
      events.filter((event) => event.stream === "item").map((event) => event.data.toolCallId),
    ).toEqual(
      events.filter((event) => event.stream === "tool").map((event) => event.data.toolCallId),
    );
    expect(events.at(-1)?.data).toMatchObject({
      title: "Read file",
      status: "completed",
      extraTypedFact: "retained",
    });
  });

  it.each([
    { finalized: true, keepState: false },
    { finalized: true, keepState: true },
    { finalized: false, keepState: false },
  ])(
    "expires recipients without dropping active runs or other state: %j",
    ({ finalized, keepState }) => {
      let now = 1_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const state = createChatRunState();
        state.toolEventRecipients.add("expired", "conn-expired");
        state.toolEventRecipients.add("active", "conn-active");
        if (keepState) {
          state.getOrCreate("expired").buffer = "retained";
        }
        if (finalized) {
          state.toolEventRecipients.markFinal("expired");
        } else {
          now = 301_000;
          expect(state.toolEventRecipients.get("active")).toEqual(new Set(["conn-active"]));
        }
        now = 1_000 + (finalized ? 30_000 : 600_000) - 1;
        if (finalized) {
          expect(state.toolEventRecipients.get("expired")).toEqual(new Set(["conn-expired"]));
        } else {
          state.toolEventRecipients.get("active");
          expect(state.runs.has("expired")).toBe(true);
        }
        now += 1;
        if (!finalized) {
          state.toolEventRecipients.get("active");
        }
        expect(state.toolEventRecipients.get("expired")).toBeUndefined();
        expect(state.toolEventRecipients.get("expired")).toBeUndefined();
        expect(state.toolEventRecipients.get("active")).toEqual(new Set(["conn-active"]));
        expect(state.runs.has("expired")).toBe(keepState);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "expires new recipients after clock rollback (clear previous state: %s)",
    (clear) => {
      let now = 1_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      try {
        const state = createChatRunState();
        state.toolEventRecipients.add("previous", "conn-previous");
        if (clear) {
          state.clear();
        }
        now = 1_000;
        state.toolEventRecipients.add("early", "conn-early");
        now = 500_000;
        state.toolEventRecipients.add("active", "conn-active");
        now = 601_000;
        expect(state.toolEventRecipients.get("active")).toEqual(new Set(["conn-active"]));
        expect(state.runs.has("early")).toBe(false);
        expect(state.runs.has("previous")).toBe(!clear);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("clears transient projection state without dropping run ownership or abort tombstones", () => {
    const state = createChatRunState();
    state.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });
    state.toolEventRecipients.add("run-1", "conn-1");
    const run = state.getOrCreate("run-1");
    Object.assign(run, {
      rawBuffer: "raw",
      buffer: "projected",
      planSnapshot: { steps: [{ step: "Inspect", status: "in_progress" }] },
      deltaSentAt: 2,
      agentText: { assistant: { lastSentAt: 3 } },
      abortMarker: createChatAbortMarker(4),
    });
    state.takeBufferDelta("run-1", "projected");
    state.recordProgressEvent("run-1", {
      runId: "run-1",
      seq: 1,
      stream: "item",
      ts: 1,
      data: { kind: "preamble", progressText: "Inspecting" },
    });

    state.updateBuffer("run-1", { itemId: "reused", text: "Saved." });
    state.retireBuffer("run-1", ["reused"]);
    state.clearRun("run-1");

    expect(state.registry.peek("run-1")?.clientRunId).toBe("client-1");
    expect(state.toolEventRecipients.get("run-1")).toEqual(new Set(["conn-1"]));
    expect(state.runs.get("run-1")).toEqual({
      lastActivityAt: expect.any(Number),
      registrations: expect.any(Array),
      abortMarker: expect.any(Object),
      toolRecipient: expect.any(Object),
    });
    state.updateBuffer("run-1", { itemId: "reused", text: "New reply." });
    expect(state.resolveBuffer("run-1").text).toBe("New reply.");
  });

  it.each(["full", "summary"] as const)(
    "retains the latest usage through %s reconnect eviction",
    (mode) => {
      const state = createChatRunState();
      const event = (seq: number, stream: string, data: Record<string, unknown>) =>
        state.recordProgressEvent("run-1", { runId: "run-1", seq, stream, ts: seq, data }, mode);
      event(1, "usage", { outputTokens: 100 });
      event(2, "usage", { outputTokens: 170 });
      event(1, "usage", { outputTokens: 100 });
      event(3, "usage", { activeContextTokens: 900 });
      for (let seq = 4; seq < 65; seq += 1) {
        event(seq, "tool", { phase: "start", toolCallId: `tool-${seq}`, name: "read" });
      }
      const snapshot = state.runs.get("run-1")?.progressSnapshot;
      expect(snapshot?.events.filter((candidate) => candidate.stream === "usage")).toEqual([
        {
          runId: "run-1",
          seq: 3,
          stream: "usage",
          ts: 3,
          data: { outputTokens: 170, activeContextTokens: 900 },
        },
      ]);
      expect(snapshot?.events).toHaveLength(50);
      expect(snapshot?.byteLength).toBeLessThanOrEqual(128 * 1024);
      state.clearRun("run-1");
      expect(state.runs.has("run-1")).toBe(false);
    },
  );

  it.each(["memory_flushing"])(
    "retains only the latest startup status (%s) until observable run activity begins",
    (phase) => {
      const state = createChatRunState();
      const event = (seq: number, stream: string, data: Record<string, unknown>) =>
        state.recordProgressEvent("run-1", {
          runId: "run-1",
          seq,
          stream,
          ts: 1_000 + seq,
          sessionKey: "main",
          data,
        });

      event(1, "run_status", { phase: "preparing_workspace" });
      event(2, "run_status", { phase });
      expect(state.runs.get("run-1")?.progressSnapshot?.events).toMatchObject([
        { seq: 2, stream: "run_status", data: { phase } },
      ]);

      event(3, "tool", { phase: "start", name: "read", toolCallId: "read-1" });
      event(4, "run_status", { phase: "starting_model" });
      expect(state.runs.get("run-1")?.progressSnapshot?.events).toMatchObject([
        { seq: 3, stream: "tool", data: { phase: "start", toolCallId: "read-1" } },
      ]);
    },
  );

  it.each(["full", "summary"] as const)(
    "retains retry waits after completed work and clears them on resumed %s activity",
    (mode) => {
      const state = createChatRunState();
      let seq = 0;
      const event = (stream: string, data: Record<string, unknown>) =>
        state.recordProgressEvent(
          "run-1",
          { runId: "run-1", seq: ++seq, stream, ts: seq, data },
          mode,
        );
      event("tool", { phase: "result", toolCallId: "read-1", name: "read", result: "done" });
      for (const stream of ["assistant", "tool", "item"]) {
        const retry = {
          phase: "retrying",
          message: "Rate limited. Retrying in 2 seconds (attempt 2/8).",
          retryAttempt: 2,
          maxRetries: 8,
          delayMs: 2_000,
        };
        event("run_status", retry);
        event("usage", { outputTokens: 100 });
        expect(state.runs.get("run-1")?.progressSnapshot?.events).toContainEqual(
          expect.objectContaining({ stream: "run_status", data: retry }),
        );
        event(
          stream,
          stream === "assistant"
            ? { text: "Continuing" }
            : stream === "tool"
              ? { phase: "start", toolCallId: "read-2", name: "read" }
              : { kind: "preamble", itemId: "resumed", progressText: "Continuing" },
        );
        expect(
          state.runs
            .get("run-1")
            ?.progressSnapshot?.events.some((entry) => entry.stream === "run_status"),
        ).toBe(false);
        if (stream === "assistant") {
          expect(state.runs.get("run-1")?.progressSnapshot?.events).toContainEqual({
            runId: "run-1",
            seq,
            stream: "assistant",
            ts: seq,
            data: {},
          });
        }
        expect(state.runs.get("run-1")?.progressSnapshot?.events).toContainEqual(
          expect.objectContaining({
            stream: "tool",
            data: expect.objectContaining({ toolCallId: "read-1", phase: "result" }),
          }),
        );
      }
    },
  );

  it("keeps completed owners and standalone notices reconstructable until bounded eviction", () => {
    const state = createChatRunState();
    const event = (seq: number, stream: string, data: Record<string, unknown>) =>
      state.recordProgressEvent("run-1", {
        runId: "run-1",
        seq,
        stream,
        ts: 1_000 + seq,
        sessionKey: "main",
        data,
      });

    event(1, "item", { kind: "preamble", itemId: "p-1", progressText: "Inspecting" });
    event(2, "tool", {
      phase: "start",
      name: "read",
      toolCallId: "active",
      args: { path: "a" },
    });
    event(3, "tool", {
      phase: "input_delta",
      name: "edit",
      toolCallId: "active",
      inputChars: 512,
      diff: { added: 3, removed: 1 },
    });
    event(4, "tool", {
      phase: "update",
      name: "read",
      toolCallId: "active",
      partialResult: "halfway",
    });
    event(5, "tool", {
      phase: "review",
      toolCallId: "active",
      review: { id: "review-1", label: "Guardian", status: "in_progress" },
    });
    event(6, "tool", {
      phase: "review",
      toolCallId: "active",
      review: { id: "review-1", label: "Guardian", status: "approved" },
    });
    event(7, "tool", {
      phase: "review",
      toolCallId: "active",
      review: { id: "review-2", label: "Guardian", status: "denied" },
    });
    event(8, "tool", { phase: "start", name: "exec", toolCallId: "done", args: {} });
    event(9, "tool", {
      phase: "result",
      name: "exec",
      toolCallId: "done",
      result: "x".repeat(256_000),
    });
    event(10, "item", {
      kind: "preamble",
      itemId: "p-1",
      progressText: "Inspection complete",
    });
    event(11, "item", {
      kind: "preamble",
      itemId: "p-2",
      progressText: "Running autoreview",
    });
    event(4, "tool", { phase: "result", name: "read", toolCallId: "active" });

    expect(state.runs.get("run-1")?.progressSnapshot?.events).toMatchObject([
      { seq: 2, stream: "tool", data: { phase: "start", toolCallId: "active" } },
      {
        seq: 3,
        stream: "tool",
        data: {
          phase: "input_delta",
          toolCallId: "active",
          inputChars: 512,
          diff: { added: 3, removed: 1 },
        },
      },
      { seq: 4, stream: "tool", data: { phase: "update", toolCallId: "active" } },
      {
        seq: 6,
        stream: "tool",
        data: {
          phase: "review",
          toolCallId: "active",
          review: { id: "review-1", status: "approved" },
        },
      },
      {
        seq: 7,
        stream: "tool",
        data: {
          phase: "review",
          toolCallId: "active",
          review: { id: "review-2", status: "denied" },
        },
      },
      { seq: 8, stream: "tool", data: { phase: "start", toolCallId: "done" } },
      { seq: 9, stream: "tool", data: { phase: "result", toolCallId: "done" } },
      {
        seq: 10,
        stream: "item",
        ts: 1_001,
        data: { itemId: "p-1", progressText: "Inspection complete" },
      },
      { seq: 11, stream: "item", data: { itemId: "p-2", progressText: "Running autoreview" } },
    ]);

    event(12, "tool", { phase: "result", name: "read", toolCallId: "active" });
    expect(
      state.runs
        .get("run-1")
        ?.progressSnapshot?.events.filter((candidate) => candidate.data.toolCallId === "active")
        .map((candidate) => candidate.data.phase),
    ).toEqual(["start", "input_delta", "update", "review", "review", "result"]);

    event(13, "codex_app_server.guardian", {
      phase: "completed",
      reviewId: "targeted-review",
      targetItemId: "active",
      status: "approved",
    });
    event(14, "codex_app_server.guardian", {
      phase: "warning",
      message: "Guardian rejection limit reached; ending turn as interrupted.",
    });
    event(15, "codex_app_server.guardian", {
      phase: "completed",
      reviewId: "network-review",
      targetItemId: null,
      status: "denied",
    });
    expect(state.runs.get("run-1")?.progressSnapshot?.events.slice(-2)).toMatchObject([
      { seq: 14, data: { phase: "warning" } },
      { seq: 15, data: { reviewId: "network-review", targetItemId: null } },
    ]);

    for (let seq = 16; seq <= 78; seq += 1) {
      event(seq, "tool", {
        phase: "start",
        name: "read",
        toolCallId: `tool-${seq}`,
        args: { payload: "y".repeat(80_000) },
      });
    }
    const snapshot = state.runs.get("run-1")?.progressSnapshot;
    expect(snapshot?.events).toHaveLength(50);
    expect(snapshot?.byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(snapshot?.events.at(-1)?.data).toEqual({
      phase: "start",
      name: "read",
      toolCallId: "tool-78",
    });
  });

  it.each(["tool", "notice"])(
    "isolates captured payloads from producer mutation before %s activity",
    (stream) => {
      const state = createChatRunState();
      const args = { text: "x".repeat(1_024) };
      for (let seq = 1; seq <= 50; seq += 1) {
        state.recordProgressEvent("run-1", {
          runId: "run-1",
          seq,
          stream: "tool",
          ts: seq,
          data: { phase: "start", toolCallId: `tool-${seq}`, args },
        });
      }
      // Tool producers can retain and update nested payload objects between events.
      args.text = "é".repeat(2_048);
      state.recordProgressEvent("run-1", {
        runId: "run-1",
        seq: 51,
        stream,
        ts: 51,
        data:
          stream === "tool"
            ? { phase: "start", toolCallId: "latest" }
            : { phase: "warning", message: "Still running" },
      });
      const snapshot = state.runs.get("run-1")?.progressSnapshot;
      expect(snapshot?.events.at(-1)?.seq).toBe(51);
      expect(snapshot?.events).toHaveLength(50);
      expect(snapshot?.events[0]?.data.args).toEqual({ text: "x".repeat(1_024) });
      expect(snapshot?.byteLength).toBe(
        snapshot?.events.reduce(
          (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
          0,
        ),
      );
      expect(snapshot?.byteLength).toBeLessThanOrEqual(128 * 1024);
    },
  );

  it("captures native tool JSON once with frozen wire values and exact byte accounting", () => {
    const state = createChatRunState();
    let serializations = 0;
    let reads = 0;
    const details = {
      toJSON: () => {
        serializations += 1;
        return {
          get text() {
            reads += 1;
            return reads === 1 ? "é" : "changed";
          },
          omitted: undefined,
          values: [undefined, Number.NaN],
        };
      },
    };
    const numberHints: string[] = [];
    const boxedNumber = Object.assign(Object(3), {
      [Symbol.toPrimitive]: (hint: string) => {
        numberHints.push(hint);
        return -3.25;
      },
    });
    const shared = { value: boxedNumber, text: Object("é"), enabled: Object(false) };
    const revocable = Proxy.revocable(["last"], {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (key === "0") {
          revocable.revoke();
        }
        return value;
      },
    });
    state.recordProgressEvent("run-1", {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: 1,
      data: {
        phase: "result",
        toolCallId: "done",
        result: { details, first: shared, again: shared, last: revocable.proxy },
      },
    });
    const firstSnapshot = state.runs.get("run-1")?.progressSnapshot;
    expect(firstSnapshot?.byteLength).toBe(
      Buffer.byteLength(JSON.stringify(firstSnapshot?.events[0])),
    );
    state.recordProgressEvent("run-1", {
      runId: "run-1",
      seq: 2,
      stream: "tool",
      ts: 2,
      data: { phase: "input_delta", toolCallId: "active", diff: { added: 1, removed: 0 } },
    });
    expect(serializations).toBe(1);
    expect(reads).toBe(1);
    expect(numberHints).toEqual(["number", "number"]);
    const snapshot = state.runs.get("run-1")?.progressSnapshot;
    expect(snapshot?.events[0]?.data.result).toEqual({
      details: { text: "é", values: [null, null] },
      first: { value: -3.25, text: "é", enabled: false },
      again: { value: -3.25, text: "é", enabled: false },
      last: ["last"],
    });
    const captured = snapshot!.events[0]!.data.result as {
      details: { text: string; values: null[] };
    };
    expect(Reflect.set(captured, "details", {})).toBe(false);
    expect(Reflect.set(captured.details, "text", "changed")).toBe(false);
    expect(Reflect.set(captured.details.values, "0", "changed")).toBe(false);
    expect(snapshot?.byteLength).toBe(
      snapshot?.events.reduce(
        (total, event) => total + Buffer.byteLength(JSON.stringify(event)),
        0,
      ),
    );
  });

  it.each([
    { prefix: 'é\n"\\\ud800', raw: false },
    { prefix: "🦞", raw: false },
    { prefix: "é", raw: true },
  ])("retains the exact JSON byte limit and stops capture on overflow: %j", ({ prefix, raw }) => {
    const encode = (text: string): unknown => {
      if (!raw) {
        return text;
      }
      if (!("rawJSON" in JSON) || typeof JSON.rawJSON !== "function") {
        throw new Error("This contract requires native JSON.rawJSON support");
      }
      return JSON.rawJSON(JSON.stringify(text));
    };
    const field = raw ? "raw" : "text";
    const state = createChatRunState();
    const metadata = { phase: "result", toolCallId: "done", ...(raw ? {} : { name: "read" }) };
    const event = {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: 1,
      data: { ...metadata, result: { [field]: encode(prefix) } },
    };
    const text = prefix + "x".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(event)));
    event.data.result[field] = encode(text);
    state.recordProgressEvent("run-1", event);
    expect(state.runs.get("run-1")?.progressSnapshot?.byteLength).toBe(64 * 1024);
    expect(state.runs.get("run-1")?.progressSnapshot?.events[0]?.data.result).toEqual({
      [field]: text,
    });
    let laterReads = 0;
    state.recordProgressEvent("run-1", {
      ...event,
      seq: 2,
      data: {
        ...metadata,
        result: {
          [field]: encode(`${text}x`),
          get later() {
            laterReads += 1;
            return "unused";
          },
        },
      },
    });
    expect(laterReads).toBe(0);
    expect(state.runs.get("run-1")?.progressSnapshot?.events[0]?.data).toEqual(metadata);
  });

  const unreplayable: { label: string; result: () => unknown; oversized?: boolean }[] = [
    { label: "single oversized", oversized: true, result: () => "x".repeat(80_000) },
    {
      label: "cumulative oversized",
      oversized: true,
      result: () => Array.from({ length: 100 }, () => "x".repeat(1_024)),
    },
    {
      label: "cyclic",
      result: () => {
        const result: { self?: unknown } = {};
        result.self = result;
        return result;
      },
    },
    { label: "bigint", result: () => 1n },
    {
      label: "boxed number coercing to bigint",
      result: () => Object.assign(Object(1), { [Symbol.toPrimitive]: () => 2n }),
    },
    {
      label: "throwing toJSON",
      result: () => ({
        toJSON: () => {
          throw new Error("unserializable tool result");
        },
      }),
    },
  ];
  it.each(unreplayable)(
    "retains metadata without reading beyond a $label result",
    ({ result, oversized }) => {
      const state = createChatRunState();
      let laterReads = 0;
      const value = result();
      state.recordProgressEvent("run-1", {
        runId: "run-1",
        seq: 1,
        stream: "tool",
        ts: 1,
        data: {
          phase: "result",
          toolCallId: "done",
          name: "read",
          result: oversized
            ? {
                body: value,
                get later() {
                  laterReads += 1;
                  return "unused";
                },
              }
            : value,
        },
      });
      expect(laterReads).toBe(0);
      const snapshot = state.runs.get("run-1")?.progressSnapshot;
      expect(snapshot?.events[0]?.data).toEqual({
        phase: "result",
        toolCallId: "done",
        name: "read",
      });
      expect(snapshot?.byteLength).toBe(Buffer.byteLength(JSON.stringify(snapshot?.events[0])));
    },
  );

  it("keeps a review-heavy reconnect bounded, adverse, and attached to its owner", () => {
    const state = createChatRunState();
    const event = (seq: number, data: Record<string, unknown>) =>
      state.recordProgressEvent("run-1", {
        runId: "run-1",
        seq,
        stream: "tool",
        ts: 1_000 + seq,
        data,
      });
    event(1, {
      phase: "start",
      name: "exec",
      toolCallId: "reviewed",
      args: { command: "printf reviewed" },
    });
    for (let index = 0; index < 60; index += 1) {
      event(index + 2, {
        phase: "review",
        toolCallId: "reviewed",
        approvalReviewOutcome: "denied",
        review: {
          id: `review-${index}`,
          label: "Guardian",
          status: index === 0 ? "denied" : "approved",
        },
      });
    }

    const events = state.runs.get("run-1")?.progressSnapshot?.events ?? [];
    expect(events[0]?.data).toMatchObject({ phase: "start", toolCallId: "reviewed" });
    const reviews = events.filter((candidate) => candidate.data.phase === "review");
    expect(reviews).toHaveLength(16);
    expect(reviews.map((candidate) => candidate.data.review)).toEqual(
      Array.from({ length: 16 }, (_, index) =>
        expect.objectContaining({ id: `review-${index + 44}` }),
      ),
    );
    expect(reviews.at(-1)?.data.approvalReviewOutcome).toBe("denied");
    expect(
      events.every(
        (candidate) =>
          candidate.data.phase === "start" ||
          events.some(
            (owner) =>
              owner.data.phase === "start" && owner.data.toolCallId === candidate.data.toolCallId,
          ),
      ),
    ).toBe(true);
  });
});

describe("createSessionMessageSubscriberRegistry", () => {
  const key = "agent:main:main";
  it.each([
    { mode: "narration", includeApprovals: false },
    { mode: undefined, includeApprovals: true },
  ] as const)("replaces subscription intent (%j) before notifying observers", (intent) => {
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe("plain", key);
    const modes: string[] = [];
    subscribers.onChange((changedKey, connId) => {
      modes.push(
        !subscribers.get(changedKey).has(connId)
          ? "none"
          : subscribers.getNarration(changedKey).has(connId)
            ? "narration"
            : "full",
      );
    });
    subscribers.subscribe("conn", key, intent);
    subscribers.subscribe("conn", key, intent);
    expect([...subscribers.get(key)]).toEqual(["plain", "conn"]);
    expect([...subscribers.getApprovals(key)]).toEqual(intent.includeApprovals ? ["conn"] : []);
    subscribers.subscribe("conn", key);
    expect([...subscribers.get(key)]).toEqual(["plain", "conn"]);
    expect([...subscribers.getApprovals(key)]).toEqual([]);
    subscribers.subscribe("conn", key, intent);
    expect([...subscribers.getApprovals(key)]).toEqual(intent.includeApprovals ? ["conn"] : []);
    if (intent.mode) {
      subscribers.unsubscribeAll("conn");
    } else {
      subscribers.unsubscribe("conn", key);
    }
    expect([...subscribers.get(key)]).toEqual(["plain"]);
    expect([...subscribers.getApprovals(key)]).toEqual([]);
    expect([...subscribers.getNarration(key)]).toEqual([]);
    expect(modes).toEqual(
      intent.mode ? ["narration", "full", "narration", "none"] : ["full", "none"],
    );
  });

  it("removes approval subscriptions only for the disconnected connection", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe("reviewer", key, { includeApprovals: true });
    subscribers.subscribe("reviewer", "child", { includeApprovals: true });
    subscribers.subscribe("other", "child", { includeApprovals: true });
    subscribers.unsubscribeAll("reviewer");
    expect([...subscribers.get(key)]).toEqual([]);
    expect([...subscribers.getApprovals(key)]).toEqual([]);
    expect([...subscribers.get("child")]).toEqual(["other"]);
    expect([...subscribers.getApprovals("child")]).toEqual(["other"]);
  });

  it.each([
    { order: "first", firstSucceeds: false, secondSucceeds: false },
    { order: "second", firstSucceeds: false, secondSucceeds: false },
    { order: "first", firstSucceeds: false, secondSucceeds: true },
    { order: "second", firstSucceeds: false, secondSucceeds: true },
    { order: "first", firstSucceeds: true, secondSucceeds: true },
    { order: "second", firstSucceeds: true, secondSucceeds: true },
  ])("settles concurrent replay intent: %j", ({ order, firstSucceeds, secondSucceeds }) => {
    const subscribers = createSessionMessageSubscriberRegistry();
    if (secondSucceeds) {
      subscribers.subscribe("conn", "other");
    }
    const first = subscribers.subscribe("conn", key, {
      provisional: true,
      includeApprovals: true,
      mode: "narration",
    })!;
    const second = subscribers.subscribe("conn", key, { provisional: true })!;
    const settleFirst = firstSucceeds ? first.commit : first;
    const settleSecond = secondSucceeds ? second.commit : second;
    if (order === "first") {
      settleFirst();
      settleSecond();
    } else {
      settleSecond();
      settleFirst();
    }
    expect([...subscribers.get(key)]).toEqual(secondSucceeds ? ["conn"] : []);
    expect([...subscribers.get("other")]).toEqual(secondSucceeds ? ["conn"] : []);
    expect([...subscribers.getApprovals(key)]).toEqual([]);
    expect([...subscribers.getNarration(key)]).toEqual([]);
  });

  it.each([
    { mode: undefined, includeApprovals: false, changeMode: true },
    { mode: "narration", includeApprovals: false, changeMode: true },
    { mode: undefined, includeApprovals: false, changeMode: false },
    { mode: undefined, includeApprovals: true, changeMode: false },
  ] as const)(
    "restores committed intent after replay failure: %j",
    ({ mode, includeApprovals, changeMode }) => {
      const subscribers = createSessionMessageSubscriberRegistry();
      const onChange = vi.fn();
      subscribers.onChange(onChange);
      subscribers.subscribe("conn", key, { mode, includeApprovals });
      subscribers.subscribe("conn", "child");
      const rollback = subscribers.subscribe("conn", key, {
        provisional: true,
        includeApprovals: !includeApprovals,
        mode: changeMode && mode !== "narration" ? "narration" : undefined,
      })!;
      rollback();
      expect([...subscribers.get(key)]).toEqual(["conn"]);
      expect([...subscribers.get("child")]).toEqual(["conn"]);
      expect([...subscribers.getNarration(key)]).toEqual(mode === "narration" ? ["conn"] : []);
      expect([...subscribers.getApprovals(key)]).toEqual(includeApprovals ? ["conn"] : []);
      if (!changeMode) {
        expect(onChange.mock.calls).toEqual([
          [key, "conn"],
          ["child", "conn"],
        ]);
      }
    },
  );

  it.each([
    { action: "unsubscribe", subscriptionId: undefined },
    { action: "disconnect", subscriptionId: undefined },
    { action: "unsubscribe", subscriptionId: "owner" },
    { action: "disconnect", subscriptionId: "owner" },
  ])(
    "fences pending settlements after invalidation and ID reuse: %j",
    ({ action, subscriptionId }) => {
      const subscribers = createSessionMessageSubscriberRegistry();
      const old = subscribers.subscribe("conn", key, {
        subscriptionId,
        provisional: true,
        includeApprovals: true,
        mode: subscriptionId ? undefined : "narration",
      })!;
      if (action === "disconnect") {
        subscribers.unsubscribeAll("conn");
      } else {
        subscribers.unsubscribe("conn", key, subscriptionId);
      }
      expect([...subscribers.get(key)]).toEqual([]);
      expect([...subscribers.getApprovals(key)]).toEqual([]);
      const replacement = subscribers.subscribe("conn", key, {
        subscriptionId,
        provisional: !subscriptionId,
        mode: subscriptionId ? "narration" : undefined,
      });
      old.commit();
      expect([...subscribers.get(key)]).toEqual(["conn"]);
      expect([...subscribers.getApprovals(key)]).toEqual([]);
      expect([...subscribers.getNarration(key)]).toEqual(subscriptionId ? ["conn"] : []);
      if (replacement) {
        replacement();
      } else {
        subscribers.subscribe("conn", key, { subscriptionId: "another" });
        subscribers.unsubscribeAll("conn");
      }
      expect([...subscribers.get(key)]).toEqual([]);
      expect([...subscribers.getApprovals(key)]).toEqual([]);
      expect([...subscribers.getNarration(key)]).toEqual([]);
    },
  );
  it("aggregates full streams and approvals while releasing only the named observer", () => {
    const registry = createSessionMessageSubscriberRegistry();
    const changes = vi.fn(() => ({
      subscribed: registry.get(key).has("conn"),
      narration: registry.getNarration(key).has("conn"),
      approvals: registry.getApprovals(key).has("conn"),
    }));
    registry.onChange(changes);
    registry.subscribe("conn", key, { subscriptionId: "foreground" });
    registry.subscribe("conn", key, {
      subscriptionId: "sidebar",
      mode: "narration",
      includeApprovals: true,
    });
    expect([...registry.getNarration(key)]).toEqual([]);
    expect([...registry.getApprovals(key)]).toEqual(["conn"]);

    registry.unsubscribe("conn", key, "foreground");
    expect(changes.mock.results.at(-1)?.value).toEqual({
      subscribed: true,
      narration: true,
      approvals: true,
    });
    registry.subscribe("conn", key);
    expect([...registry.getNarration(key)]).toEqual([]);
    registry.unsubscribe("conn", key);
    expect([...registry.getNarration(key)]).toEqual(["conn"]);
    registry.unsubscribe("conn", key, "unknown");
    expect([...registry.get(key)]).toEqual(["conn"]);

    registry.unsubscribe("conn", key, "sidebar");
    expect(changes.mock.results.at(-1)?.value).toEqual({
      subscribed: false,
      narration: false,
      approvals: false,
    });
  });

  it.each([
    { separateOwners: true, succeeds: false },
    { separateOwners: false, succeeds: false },
    { separateOwners: false, succeeds: true },
  ])(
    "retains foreground delivery until pending ownership settles: %j",
    ({ separateOwners, succeeds }) => {
      const registry = createSessionMessageSubscriberRegistry();
      const foregroundId = separateOwners ? "foreground" : "owner";
      const narrationId = separateOwners ? "sidebar" : "owner";
      if (separateOwners) {
        registry.subscribe("conn", key, { subscriptionId: narrationId, mode: "narration" });
      }
      const foreground = registry.subscribe("conn", key, {
        subscriptionId: foregroundId,
        provisional: true,
        includeApprovals: separateOwners,
      })!;
      const narration = registry.subscribe("conn", key, {
        subscriptionId: narrationId,
        provisional: true,
        mode: "narration",
      })!;
      expect([...registry.getNarration(key)]).toEqual([]);
      expect([...registry.getApprovals(key)]).toEqual(separateOwners ? ["conn"] : []);
      if (separateOwners) {
        narration();
      } else {
        narration.commit();
      }
      expect([...registry.getNarration(key)]).toEqual([]);
      expect([...registry.getApprovals(key)]).toEqual(separateOwners ? ["conn"] : []);
      if (succeeds) {
        foreground.commit();
      } else {
        foreground();
      }
      expect([...registry.getNarration(key)]).toEqual(["conn"]);
      expect([...registry.getApprovals(key)]).toEqual([]);
    },
  );
});
