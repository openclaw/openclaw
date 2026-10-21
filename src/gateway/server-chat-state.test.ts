import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createChatAbortMarker,
  createChatRunState,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";

type ReplayMode = Parameters<ReturnType<typeof createChatRunState>["recordProgressEvent"]>[2];
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const resultMetadata = { phase: "result", toolCallId: "done", name: "read" };

function progressHarness(mode?: ReplayMode, timeOffset = 0, sessionKey?: string) {
  const state = createChatRunState();
  const context = { runId: "run-1", ...(sessionKey ? { sessionKey } : {}) };
  const wire = (seq: number, stream: string, data: Record<string, unknown>) => ({
    ...context,
    seq,
    stream,
    ts: timeOffset + seq,
    data,
  });
  const event = (seq: number, stream: string, data: Record<string, unknown>) =>
    state.recordProgressEvent(context.runId, wire(seq, stream, data), mode);
  const snapshot = () => state.runs.get("run-1")?.progressSnapshot;
  let seq = 0;
  const send = (stream: string, data: Record<string, unknown>) => event(++seq, stream, data);
  return { state, wire, event, send, snapshot, events: () => snapshot()?.events };
}

function withUnreadTail(field: string, value: unknown, onRead: () => void) {
  return {
    [field]: value,
    get later() {
      onRead();
      return "unused";
    },
  };
}

function mockClock(now: number) {
  const clock = { now };
  const spy = vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  onTestFinished(() => spy.mockRestore());
  return clock;
}

const sessionKey = "agent:main:main";
function subscriptionHarness() {
  const registry = createSessionMessageSubscriberRegistry();
  return {
    registry,
    subscribe: (options?: Parameters<typeof registry.subscribe>[2]) =>
      registry.subscribe("conn", sessionKey, options),
    snapshot: (key = sessionKey) => [
      [...registry.get(key)],
      [...registry.getApprovals(key)],
      [...registry.getNarration(key)],
    ],
  };
}

describe("createChatRunState", () => {
  it("replays complete prepared items and evicts raw and item siblings together", () => {
    const { send, events: getEvents } = progressHarness();
    const preamble = { itemId: "preamble", kind: "preamble", title: "Status" };
    send("item", { ...preamble, phase: "end", status: "completed", progressText: "Ready" });
    send("item", { ...preamble, phase: "update", status: "running", progressText: "Checking" });
    expect(getEvents()).toMatchObject([
      { data: { phase: "end", progressText: "Ready", title: "Status", status: "completed" } },
    ]);
    send("item", { itemId: "preamble", kind: "preamble", phase: "start", progressText: "" });
    expect(getEvents()).toEqual([]);
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
    const events = getEvents() ?? [];
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
  ])("expires recipients but retains active runs/state: %j", ({ finalized, keepState }) => {
    const clock = mockClock(1_000);
    const state = createChatRunState();
    state.toolEventRecipients.add("expired", "conn-expired");
    state.toolEventRecipients.add("active", "conn-active");
    if (keepState) {
      state.getOrCreate("expired").buffer = "retained";
    }
    if (finalized) {
      state.toolEventRecipients.markFinal("expired");
    } else {
      clock.now = 301_000;
      expect(state.toolEventRecipients.get("active")).toEqual(new Set(["conn-active"]));
    }
    clock.now = 1_000 + (finalized ? 30_000 : 600_000) - 1;
    if (finalized) {
      expect(state.toolEventRecipients.get("expired")).toEqual(new Set(["conn-expired"]));
    } else {
      state.toolEventRecipients.get("active");
      expect(state.runs.has("expired")).toBe(true);
    }
    clock.now += 1;
    if (!finalized) {
      state.toolEventRecipients.get("active");
    }
    expect(state.toolEventRecipients.get("expired")).toBeUndefined();
    expect(state.toolEventRecipients.get("expired")).toBeUndefined();
    expect(state.toolEventRecipients.get("active")).toEqual(new Set(["conn-active"]));
    expect(state.runs.has("expired")).toBe(keepState);
  });

  it.each([false, true])(
    "expires new recipients after clock rollback (clear previous state: %s)",
    (clear) => {
      const clock = mockClock(1_000_000);
      const state = createChatRunState();
      state.toolEventRecipients.add("previous", "conn-previous");
      if (clear) {
        state.clear();
      }
      clock.now = 1_000;
      state.toolEventRecipients.add("early", "conn-early");
      clock.now = 500_000;
      state.toolEventRecipients.add("active", "conn-active");
      clock.now = 601_000;
      expect(state.toolEventRecipients.get("active")).toEqual(new Set(["conn-active"]));
      expect(state.runs.has("early")).toBe(false);
      expect(state.runs.has("previous")).toBe(!clear);
    },
  );

  it("clears projections but retains ownership and abort tombstones", () => {
    const { state, event } = progressHarness();
    state.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });
    state.toolEventRecipients.add("run-1", "conn-1");
    const run = state.getOrCreate("run-1");
    const releaseBufferAuthority = vi.fn();
    Object.assign(run, {
      releaseBufferAuthority,
      rawBuffer: "raw",
      buffer: "projected",
      planSnapshot: { steps: [{ step: "Inspect", status: "in_progress" }] },
      deltaSentAt: 2,
      agentText: { assistant: { lastSentAt: 3 } },
      abortMarker: createChatAbortMarker(4),
    });
    state.takeBufferDelta("run-1", "projected");
    event(1, "item", { kind: "preamble", progressText: "Inspecting" });

    state.updateBuffer("run-1", { itemId: "reused", text: "Saved." });
    state.retireBuffer("run-1", ["reused"]);
    state.clearRun("run-1");

    expect(releaseBufferAuthority).toHaveBeenCalledOnce();
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
      const { state, wire, event, snapshot: getSnapshot } = progressHarness(mode);
      event(1, "usage", { outputTokens: 100 });
      event(2, "usage", { outputTokens: 170 });
      event(1, "usage", { outputTokens: 100 });
      event(3, "usage", { activeContextTokens: 900 });
      for (let seq = 4; seq < 65; seq += 1) {
        event(seq, "tool", { phase: "start", toolCallId: `tool-${seq}`, name: "read" });
      }
      const snapshot = getSnapshot();
      const usage = snapshot?.events.filter((candidate) => candidate.stream === "usage");
      expect(usage).toEqual([wire(3, "usage", { outputTokens: 170, activeContextTokens: 900 })]);
      expect(snapshot?.events).toHaveLength(50);
      expect(snapshot?.byteLength).toBeLessThanOrEqual(128 * 1024);
      state.clearRun("run-1");
      expect(state.runs.has("run-1")).toBe(false);
    },
  );

  it("retains the latest startup status until observable run activity begins", () => {
    const phase = "memory_flushing";
    const { event, events } = progressHarness();

    event(1, "run_status", { phase: "preparing_workspace" });
    event(2, "run_status", { phase });
    expect(events()).toMatchObject([{ seq: 2, stream: "run_status", data: { phase } }]);

    event(3, "tool", { phase: "start", name: "read", toolCallId: "read-1" });
    event(4, "run_status", { phase: "starting_model" });
    expect(events()).toMatchObject([
      { seq: 3, stream: "tool", data: { phase: "start", toolCallId: "read-1" } },
    ]);
    event(5, "run_status", { phase: "waiting_for_model", reason: "slot" });
    expect(events()).toMatchObject([
      { seq: 3, stream: "tool" },
      { seq: 5, stream: "run_status", data: { phase: "waiting_for_model", reason: "slot" } },
    ]);
    event(6, "run_status", { phase: "starting_model" });
    expect(events()).toMatchObject([
      { seq: 3, stream: "tool" },
      { seq: 6, stream: "run_status", data: { phase: "starting_model" } },
    ]);
  });

  const fallbackTransition = {
    phase: "fallback_step",
    fallbackStepFromModel: "primary/model",
    fallbackStepToModel: "backup/model",
    fallbackStepFinalOutcome: "next_fallback",
  };
  it.each([
    { mode: "full", data: { phase: "finishing" } },
    { mode: "summary", data: { phase: "finishing" } },
    { mode: "full", data: fallbackTransition },
    { mode: "summary", data: fallbackTransition },
  ] as const)("retains $data.phase until resumed $mode activity", ({ mode, data }) => {
    const { event, events } = progressHarness(mode);
    event(1, "lifecycle", data);
    expect(events()).toMatchObject([{ stream: "lifecycle", data }]);
    event(2, "assistant", { text: "Recovered" });
    expect(events()).toMatchObject([{ stream: "assistant", seq: 2 }]);
  });

  it.each(["full", "summary"] as const)("retains retry waits until resumed %s activity", (mode) => {
    const { wire, send, events } = progressHarness(mode);
    let seq = 1;
    send("tool", { phase: "result", toolCallId: "read-1", name: "read", result: "done" });
    for (const [stream, data] of [
      ["assistant", { text: "Continuing" }],
      ["tool", { phase: "start", toolCallId: "read-2", name: "read" }],
      ["item", { kind: "preamble", itemId: "resumed", progressText: "Continuing" }],
    ] as const) {
      const retry = {
        phase: "retrying",
        message: "Rate limited. Retrying in 2 seconds (attempt 2/8).",
        retryAttempt: 2,
        maxRetries: 8,
        delayMs: 2_000,
        retryAt: 1_800_000_002_000,
      };
      send("run_status", retry);
      send("usage", { outputTokens: 100 });
      expect(events()).toContainEqual(
        expect.objectContaining({ stream: "run_status", data: retry }),
      );
      send(stream, data);
      seq += 3;
      expect(events()?.some((entry) => entry.stream === "run_status")).toBe(false);
      if (stream === "assistant") {
        expect(events()).toContainEqual(wire(seq, "assistant", {}));
      }
      expect(events()).toContainEqual(
        expect.objectContaining({
          stream: "tool",
          data: expect.objectContaining({ toolCallId: "read-1", phase: "result" }),
        }),
      );
    }
  });

  it.each(["full", "summary"] as const)(
    "retains permission notices for %s reconnect history",
    (mode) => {
      const { wire, event, events } = progressHarness(mode, 999, "main");
      const data = {
        phase: "warning",
        kind: "permission_missing",
        permissionMissing: {
          nodeId: "mac-node",
          command: "screen.snapshot",
          capabilities: ["screenRecording"],
          state: "not-determined",
        },
      };
      event(1, "notice", data);
      expect(events()).toEqual([wire(1, "notice", data)]);
    },
  );

  it("replays completed owners and standalone notices until bounded eviction", () => {
    const { event, events, snapshot: getSnapshot } = progressHarness(undefined, 1_000, "main");
    const tool = (
      seq: number,
      phase: string,
      toolCallId: string,
      data: Record<string, unknown> = {},
    ) => event(seq, "tool", { phase, toolCallId, ...data });
    const review = (seq: number, id: string, status: string) =>
      tool(seq, "review", "active", { review: { id, label: "Guardian", status } });
    const preamble = (seq: number, itemId: string, progressText: string) =>
      event(seq, "item", { kind: "preamble", itemId, progressText });

    preamble(1, "p-1", "Inspecting");
    tool(2, "start", "active", { name: "read", args: { path: "a" } });
    tool(3, "input_delta", "active", { name: "edit", diff: { added: 3, removed: 1 } });
    tool(4, "update", "active", { name: "read", partialResult: "halfway" });
    review(5, "review-1", "in_progress");
    review(6, "review-1", "approved");
    review(7, "review-2", "denied");
    tool(8, "start", "done", { name: "exec", args: {} });
    tool(9, "result", "done", { name: "exec", result: "x".repeat(256_000) });
    preamble(10, "p-1", "Inspection complete");
    preamble(11, "p-2", "Running autoreview");
    tool(4, "result", "active", { name: "read" });

    expect(events()?.map(({ seq, stream, data }) => [seq, stream, data])).toMatchObject([
      [2, "tool", { phase: "start", toolCallId: "active" }],
      [3, "tool", { phase: "input_delta", toolCallId: "active", diff: { added: 3, removed: 1 } }],
      [4, "tool", { phase: "update", toolCallId: "active" }],
      [
        6,
        "tool",
        { phase: "review", toolCallId: "active", review: { id: "review-1", status: "approved" } },
      ],
      [
        7,
        "tool",
        { phase: "review", toolCallId: "active", review: { id: "review-2", status: "denied" } },
      ],
      [8, "tool", { phase: "start", toolCallId: "done" }],
      [9, "tool", { phase: "result", toolCallId: "done" }],
      [10, "item", { itemId: "p-1", progressText: "Inspection complete" }],
      [11, "item", { itemId: "p-2", progressText: "Running autoreview" }],
    ]);
    expect(events()?.find(({ seq }) => seq === 10)?.ts).toBe(1_001);

    tool(12, "result", "active", { name: "read" });
    expect(
      events()
        ?.filter((candidate) => candidate.data.toolCallId === "active")
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
    expect(events()?.slice(-2)).toMatchObject([
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
    const snapshot = getSnapshot();
    expect(snapshot?.events).toHaveLength(50);
    expect(snapshot?.byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(snapshot?.events.at(-1)?.data).toEqual({
      phase: "start",
      name: "read",
      toolCallId: "tool-78",
    });
  });

  it("captures native JSON once, frozen and byte-exact", () => {
    const { event, snapshot: getSnapshot } = progressHarness();
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
    event(1, "tool", {
      phase: "result",
      toolCallId: "done",
      result: { details, first: shared, again: shared, last: revocable.proxy },
    });
    const firstSnapshot = getSnapshot();
    expect(firstSnapshot?.byteLength).toBe(jsonBytes(firstSnapshot?.events[0]));
    event(2, "tool", {
      phase: "input_delta",
      toolCallId: "active",
      diff: { added: 1, removed: 0 },
    });
    expect([serializations, reads, numberHints]).toEqual([1, 1, ["number", "number"]]);
    const snapshot = getSnapshot();
    expect(snapshot?.events[0]?.data.result).toEqual({
      details: { text: "é", values: [null, null] },
      first: { value: -3.25, text: "é", enabled: false },
      again: { value: -3.25, text: "é", enabled: false },
      last: ["last"],
    });
    const captured = snapshot!.events[0]!.data.result as {
      details: { text: string; values: null[] };
    };
    expect([
      Reflect.set(captured, "details", {}),
      Reflect.set(captured.details, "text", "changed"),
      Reflect.set(captured.details.values, "0", "changed"),
    ]).toEqual([false, false, false]);
    expect(snapshot?.byteLength).toBe(
      snapshot?.events.reduce((sum, entry) => sum + jsonBytes(entry), 0),
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
    const metadata = raw ? { phase: "result", toolCallId: "done" } : resultMetadata;
    const event = {
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: 1,
      data: { ...metadata, result: { [field]: encode(prefix) } },
    };
    const text = prefix + "x".repeat(64 * 1024 - jsonBytes(event));
    event.data.result[field] = encode(text);
    state.recordProgressEvent("run-1", event);
    expect(state.runs.get("run-1")?.progressSnapshot?.byteLength).toBe(64 * 1024);
    expect(state.runs.get("run-1")?.progressSnapshot?.events[0]?.data.result).toEqual({
      [field]: text,
    });
    const laterRead = vi.fn();
    state.recordProgressEvent("run-1", {
      ...event,
      seq: 2,
      data: {
        ...metadata,
        result: withUnreadTail(field, encode(`${text}x`), laterRead),
      },
    });
    expect(laterRead).not.toHaveBeenCalled();
    expect(state.runs.get("run-1")?.progressSnapshot?.events[0]?.data).toEqual(metadata);
  });

  const unreplayable: [label: string, result: () => unknown, field?: string][] = [
    ["container-only oversized", () => Array.from({ length: 32_768 }, () => ({})), "rows"],
    ["single oversized", () => "x".repeat(80_000), "body"],
    ["cumulative oversized", () => Array.from({ length: 100 }, () => "x".repeat(1_024)), "body"],
    [
      "cyclic",
      () => {
        const result: { self?: unknown } = {};
        result.self = result;
        return result;
      },
    ],
    ["bigint", () => 1n],
    [
      "boxed number coercing to bigint",
      () => Object.assign(Object(1), { [Symbol.toPrimitive]: () => 2n }),
    ],
    [
      "throwing toJSON",
      () => ({
        toJSON: () => {
          throw new Error("unserializable tool result");
        },
      }),
    ],
  ];
  it.each(unreplayable)(
    "retains metadata without reading beyond a %s result",
    (_label, result, field) => {
      const { event, snapshot: getSnapshot } = progressHarness();
      const laterRead = vi.fn();
      const value = result();
      event(1, "tool", {
        ...resultMetadata,
        result: field ? withUnreadTail(field, value, laterRead) : value,
      });
      expect(laterRead).not.toHaveBeenCalled();
      const snapshot = getSnapshot();
      expect(snapshot?.events[0]?.data).toEqual(resultMetadata);
      expect(snapshot?.byteLength).toBe(jsonBytes(snapshot?.events[0]));
    },
  );

  it("bounds review-heavy reconnects with adverse outcomes attached to owners", () => {
    const { event: record, events: getEvents } = progressHarness(undefined, 1_000);
    const event = (seq: number, data: Record<string, unknown>) => record(seq, "tool", data);
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

    const events = getEvents() ?? [];
    expect(events[0]?.data).toMatchObject({ phase: "start", toolCallId: "reviewed" });
    const reviews = events.filter((candidate) => candidate.data.phase === "review");
    expect(reviews).toHaveLength(16);
    expect(reviews.map((candidate) => candidate.data.review)).toEqual(
      Array.from({ length: 16 }, (_, index) =>
        expect.objectContaining({ id: `review-${index + 44}` }),
      ),
    );
    expect(reviews.at(-1)?.data.approvalReviewOutcome).toBe("denied");
    const owners = new Set(
      events.filter(({ data }) => data.phase === "start").map(({ data }) => data.toolCallId),
    );
    expect(events.every(({ data }) => data.phase === "start" || owners.has(data.toolCallId))).toBe(
      true,
    );
  });
});

describe("createSessionMessageSubscriberRegistry", () => {
  const key = sessionKey;
  it("removes approval subscriptions only for the disconnected connection", () => {
    const { registry: subscribers, snapshot } = subscriptionHarness();
    subscribers.subscribe("reviewer", key, { includeApprovals: true });
    subscribers.subscribe("reviewer", "child", { includeApprovals: true });
    subscribers.subscribe("other", "child", { includeApprovals: true });
    subscribers.unsubscribeAll("reviewer");
    expect(snapshot()).toEqual([[], [], []]);
    expect(snapshot("child")).toEqual([["other"], ["other"], []]);
  });

  it.each([
    { order: "first", firstSucceeds: false, secondSucceeds: false },
    { order: "second", firstSucceeds: false, secondSucceeds: false },
    { order: "first", firstSucceeds: false, secondSucceeds: true },
    { order: "second", firstSucceeds: false, secondSucceeds: true },
    { order: "first", firstSucceeds: true, secondSucceeds: true },
    { order: "second", firstSucceeds: true, secondSucceeds: true },
  ])("settles concurrent replay intent: %j", ({ order, firstSucceeds, secondSucceeds }) => {
    const { registry: subscribers, subscribe, snapshot } = subscriptionHarness();
    if (secondSucceeds) {
      subscribers.subscribe("conn", "other");
    }
    const first = subscribe({ provisional: true, includeApprovals: true, mode: "narration" })!;
    const second = subscribe({ provisional: true })!;
    const settleFirst = firstSucceeds ? first.commit : first;
    const settleSecond = secondSucceeds ? second.commit : second;
    for (const settle of order === "first"
      ? [settleFirst, settleSecond]
      : [settleSecond, settleFirst]) {
      settle();
    }
    expect(snapshot()).toEqual([secondSucceeds ? ["conn"] : [], [], []]);
    expect([...subscribers.get("other")]).toEqual(secondSucceeds ? ["conn"] : []);
  });

  it.each([
    { mode: undefined, includeApprovals: false, changeMode: true },
    { mode: "narration", includeApprovals: false, changeMode: true },
    { mode: undefined, includeApprovals: false, changeMode: false },
    { mode: undefined, includeApprovals: true, changeMode: false },
  ] as const)(
    "restores intent after replay failure: %j",
    ({ mode, includeApprovals, changeMode }) => {
      const { registry: subscribers, subscribe, snapshot } = subscriptionHarness();
      const onChange = vi.fn();
      subscribers.onChange(onChange);
      subscribe({ mode, includeApprovals });
      subscribers.subscribe("conn", "child");
      const rollback = subscribe({
        provisional: true,
        includeApprovals: !includeApprovals,
        mode: changeMode && mode !== "narration" ? "narration" : undefined,
      })!;
      rollback();
      expect(snapshot()).toEqual([
        ["conn"],
        includeApprovals ? ["conn"] : [],
        mode === "narration" ? ["conn"] : [],
      ]);
      expect([...subscribers.get("child")]).toEqual(["conn"]);
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
  ])("fences settlement after invalidation and ID reuse: %j", ({ action, subscriptionId }) => {
    const { registry: subscribers, subscribe, snapshot } = subscriptionHarness();
    const old = subscribe({
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
    expect(snapshot()).toEqual([[], [], []]);
    const replacement = subscribe({
      subscriptionId,
      provisional: !subscriptionId,
      mode: subscriptionId ? "narration" : undefined,
    });
    old.commit();
    expect(snapshot()).toEqual([["conn"], [], subscriptionId ? ["conn"] : []]);
    if (replacement) {
      replacement();
    } else {
      subscribe({ subscriptionId: "another" });
      subscribers.unsubscribeAll("conn");
    }
    expect(snapshot()).toEqual([[], [], []]);
  });
  it.each([
    { separateOwners: true, succeeds: false },
    { separateOwners: false, succeeds: false },
    { separateOwners: false, succeeds: true },
  ])("retains foreground until ownership settles: %j", ({ separateOwners, succeeds }) => {
    const { subscribe, snapshot } = subscriptionHarness();
    const foregroundId = separateOwners ? "foreground" : "owner";
    const narrationId = separateOwners ? "sidebar" : "owner";
    if (separateOwners) {
      subscribe({ subscriptionId: narrationId, mode: "narration" });
    }
    const foreground = subscribe({
      subscriptionId: foregroundId,
      provisional: true,
      includeApprovals: separateOwners,
    })!;
    const narration = subscribe({
      subscriptionId: narrationId,
      provisional: true,
      mode: "narration",
    })!;
    expect(snapshot().slice(1)).toEqual([separateOwners ? ["conn"] : [], []]);
    (separateOwners ? narration : narration.commit)();
    expect(snapshot().slice(1)).toEqual([separateOwners ? ["conn"] : [], []]);
    (succeeds ? foreground.commit : foreground)();
    expect(snapshot().slice(1)).toEqual([[], ["conn"]]);
  });
});
