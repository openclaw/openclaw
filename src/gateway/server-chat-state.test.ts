import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
} from "../agents/internal-runtime-context.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { AgentAssistantSourceReceipt } from "../infra/agent-events.js";
import * as jsonUtf8 from "../infra/json-utf8-bytes.js";
import * as codeRegions from "../shared/text/code-regions.js";
import { projectInFlightRunSnapshot } from "./chat-inflight-snapshot.js";
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
  const expectEvents = (...expected: Array<[number, string, Record<string, unknown>]>) =>
    expect(snapshot()?.events.map(({ seq, stream, data }) => [seq, stream, data])).toMatchObject(
      expected,
    );
  let seq = 0;
  const send = (stream: string, data: Record<string, unknown>) => event(++seq, stream, data);
  const tool = (
    sequence: number,
    phase: string,
    toolCallId: string,
    data: Record<string, unknown> = {},
  ) => event(sequence, "tool", { phase, toolCallId, ...data });
  return {
    state,
    wire,
    event,
    send,
    tool,
    snapshot,
    expectEvents,
    events: () => snapshot()?.events,
  };
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
    const abortMarker = createChatAbortMarker(4);
    Object.assign(run, {
      releaseBufferAuthority,
      abortMarker,
    });
    state.takeBufferDelta("run-1", "projected");
    event(1, "item", { kind: "preamble", progressText: "Inspecting" });

    state.updateBuffer("run-1", { itemId: "reused", text: "Saved." });
    state.retireBuffer("run-1", ["reused"]);
    state.clearRun("run-1");

    expect(releaseBufferAuthority).toHaveBeenCalledOnce();
    expect(state.registry.peek("run-1")?.clientRunId).toBe("client-1");
    expect(state.toolEventRecipients.get("run-1")).toEqual(new Set(["conn-1"]));
    expect(state.resolveBuffer("run-1").text).toBe("");
    expect(state.runs.get("run-1")?.abortMarker).toBe(abortMarker);
    state.updateBuffer("run-1", { itemId: "reused", text: "New reply." });
    expect(state.resolveBuffer("run-1").text).toBe("New reply.");
  });

  it("retains the latest usage through summary reconnect eviction", () => {
    const { state, wire, event, snapshot: getSnapshot } = progressHarness("summary");
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
  });

  it("retains the latest startup status until observable run activity begins", () => {
    const { event, expectEvents } = progressHarness();

    event(1, "run_status", { phase: "preparing_workspace" });
    event(2, "run_status", { phase: "memory_flushing" });
    expectEvents([2, "run_status", { phase: "memory_flushing" }]);

    event(3, "tool", { phase: "start", name: "read", toolCallId: "read-1" });
    event(4, "run_status", { phase: "starting_model" });
    expectEvents([3, "tool", { phase: "start", toolCallId: "read-1" }]);
    event(5, "run_status", { phase: "waiting_for_model", reason: "slot" });
    expectEvents(
      [3, "tool", {}],
      [5, "run_status", { phase: "waiting_for_model", reason: "slot" }],
    );
    event(6, "run_status", { phase: "starting_model" });
    expectEvents([3, "tool", {}], [6, "run_status", { phase: "starting_model" }]);
  });

  it("replays the latest recovery compaction after an attempt failure (summary)", () => {
    const { state, event } = progressHarness("summary");
    const replay = () => projectInFlightRunSnapshot({ chatRunState: state, runId: "run-1" }).events;
    event(1, "lifecycle", {
      phase: "finishing",
      error: "Context overflow",
      livenessState: "blocked",
      endedAt: 1,
    });
    event(2, "compaction", { phase: "start", itemId: "recovery-1" });
    expect(replay()).toMatchObject([
      { seq: 2, stream: "compaction", data: { phase: "start", itemId: "recovery-1" } },
    ]);
    event(3, "compaction", { phase: "end", itemId: "recovery-1", completed: true });
    expect(replay()).toMatchObject([
      { seq: 3, stream: "compaction", data: { phase: "end", completed: true } },
    ]);
    event(4, "compaction", { phase: "start", itemId: "recovery-2" });
    event(3, "compaction", { phase: "end", itemId: "recovery-1", completed: true });
    expect(replay()).toMatchObject([
      { seq: 4, stream: "compaction", data: { phase: "start", itemId: "recovery-2" } },
    ]);
    event(5, "compaction", { phase: "end", itemId: "recovery-2", completed: false });
    event(6, "lifecycle", { phase: "finishing" });
    expect(replay()).toMatchObject([
      { seq: 5, stream: "compaction", data: { phase: "end", completed: false } },
      { seq: 6, stream: "lifecycle", data: { phase: "finishing" } },
    ]);
  });

  const fallbackTransition = {
    phase: "fallback_step",
    fallbackStepFromModel: "primary/model",
    fallbackStepToModel: "backup/model",
    fallbackStepFinalOutcome: "next_fallback",
  };
  it.each([
    { mode: "summary", data: { phase: "finishing" } },
    { mode: "summary", data: fallbackTransition },
  ] as const)("retains $data.phase until resumed $mode activity", ({ mode, data }) => {
    const { event, events } = progressHarness(mode);
    event(1, "lifecycle", data);
    expect(events()).toMatchObject([{ stream: "lifecycle", data }]);
    event(2, "assistant", { text: "Recovered" });
    expect(events()).toMatchObject([{ stream: "assistant", seq: 2 }]);
  });

  it.each([
    ["assistant", { text: "Continuing" }],
    ["tool", { phase: "start", toolCallId: "read-2", name: "read" }],
    ["item", { kind: "preamble", itemId: "resumed", progressText: "Continuing" }],
  ] as const)("retains retry waits until resumed %s activity", (stream, data) => {
    const { wire, send, events } = progressHarness("summary");
    send("tool", { phase: "result", toolCallId: "read-1", name: "read", result: "done" });
    const retry = { phase: "retrying", retryAttempt: 2, maxRetries: 8, delayMs: 2_000 };
    send("run_status", retry);
    send("usage", { outputTokens: 100 });
    expect(events()).toContainEqual(expect.objectContaining({ stream: "run_status", data: retry }));
    send(stream, data);
    expect(events()?.some((entry) => entry.stream === "run_status")).toBe(false);
    if (stream === "assistant") {
      expect(events()).toContainEqual(wire(4, "assistant", {}));
    }
    expect(events()).toContainEqual(
      expect.objectContaining({
        stream: "tool",
        data: expect.objectContaining({ toolCallId: "read-1", phase: "result" }),
      }),
    );
  });

  it("replays completed owners and standalone notices", () => {
    const { event, tool, events } = progressHarness(undefined, 1_000, "main");
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
    tool(9, "result", "done", { name: "exec" });
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
  });

  it("captures native JSON once, frozen and byte-exact", () => {
    const { tool, snapshot: getSnapshot } = progressHarness();
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
    using inspection = vi.spyOn(Object, "getPrototypeOf");
    using traversal = vi.spyOn(jsonUtf8, "boundedJsonUtf8Bytes");
    tool(1, "result", "done", {
      result: { details, first: shared, again: shared, last: revocable.proxy },
    });
    const firstSnapshot = getSnapshot();
    expect(traversal).not.toHaveBeenCalled();
    const capturedResult = firstSnapshot!.events[0]!.data.result;
    const capturedInspections = inspection.mock.calls.filter(
      ([value]) => value === capturedResult,
    ).length;
    inspection.mockRestore();
    expect(capturedInspections).toBe(0);
    expect(firstSnapshot?.byteLength).toBe(jsonBytes(firstSnapshot?.events[0]));
    tool(2, "input_delta", "active", { diff: { added: 1, removed: 0 } });
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
    { prefix: 'é🦞\n"\\\ud800', raw: false },
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
    const { wire, tool, snapshot } = progressHarness();
    const base = wire(1, "tool", { ...resultMetadata, result: { text: encode(prefix) } });
    const text = prefix + "x".repeat(64 * 1024 - jsonBytes(base));
    tool(1, "result", "done", { name: "read", result: { text: encode(text) } });
    expect(snapshot()?.byteLength).toBe(64 * 1024);
    expect(snapshot()?.events[0]?.data.result).toEqual({ text });
    const laterRead = vi.fn();
    tool(2, "result", "done", {
      name: "read",
      result: withUnreadTail("text", encode(`${text}x`), laterRead),
    });
    expect(laterRead).not.toHaveBeenCalled();
    expect(snapshot()?.events[0]?.data).toEqual(resultMetadata);
  });

  const unreplayable: [label: string, result: () => unknown, field?: string][] = [
    ["container-only oversized", () => Array.from({ length: 32_768 }, () => ({})), "rows"],
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
    const { tool, events: getEvents } = progressHarness(undefined, 1_000);
    tool(1, "start", "reviewed", { name: "exec", args: { command: "printf reviewed" } });
    for (let index = 0; index < 60; index += 1) {
      tool(index + 2, "review", "reviewed", {
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

describe("assistant text projection", () => {
  const directive = "`[[reply_to_current]]`";

  let state: ReturnType<typeof createChatRunState>;
  beforeEach(() => {
    state = createChatRunState();
  });
  afterEach(() => vi.restoreAllMocks());

  function expectUpdate(input: Parameters<typeof state.updateBuffer>[1], text: string | undefined) {
    state.updateBuffer("reply", input);
    expect(state.resolveBuffer("reply").text).toBe(text);
  }

  it.each([
    ["literal trailing marker", "The token is ", SILENT_REPLY_TOKEN],
    ["punctuated literal suffix", "The token is ", `${SILENT_REPLY_TOKEN}.`],
    ["prepared literal marker", "", SILENT_REPLY_TOKEN],
    ["prepared short reply", SILENT_REPLY_TOKEN.slice(0, 1), SILENT_REPLY_TOKEN.slice(1, 2)],
    [
      "runtime directive",
      `Opening\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\nPrivate`,
      ` context\n${INTERNAL_RUNTIME_CONTEXT_END}\nVisible`,
      " context\nVisible",
    ],
    ["media directive", "Opening\nMEDIA", ":./model.png\nVisible"],
    ["code literal", "`", "[[reply_to_current]]`", "`"],
    ["media URL", "Opening\nMEDIA:prose ./model.png ", "https://example.com/a.png\n"],
  ])("preserves prepared source for %s", (_name, prefix, suffix, expected = suffix) => {
    const runId = "source-classification";
    if (prefix) {
      state.updateBuffer(runId, { itemId: "native", occurrenceId: "a", text: prefix });
    }
    state.updateBuffer(runId, {
      itemId: "native",
      occurrenceId: "b",
      text: prefix + suffix,
      managedMediaUrls: ["./model.png"],
    });
    if (prefix) {
      state.retireBuffer(runId, ["a"]);
    }
    expect.soft(state.resolveBuffer(runId)).toMatchObject({ text: expected, suppress: !expected });
    expect.soft(projectInFlightRunSnapshot({ chatRunState: state, runId }).text).toBe(expected);
    const final = state.resolveBuffer(runId, { final: true });
    expect(final.displayText ?? final.text).toBe(expected);
  });

  it("matches terminal receipts by identity, not text", () => {
    state.retireBuffer("reply", ["superseded"]);
    state.retireBuffer("reply", ["selected"]);
    expectUpdate({ itemId: "selected", text: "Same.", replace: true, replaceable: true }, "");
    expectUpdate({ itemId: "new", text: "Same.", replace: true, replaceable: true }, "Same.");
  });

  it.each(["anonymous", "native"])("aligns %s deltas after empty items", (kind) => {
    state.updateBuffer("reply", { itemId: "first", text: "Visible." });
    state.updateBuffer("reply", { itemId: "second", occurrenceId: "saved", text: "Saved" });
    state.retireBuffer("reply", ["saved"]);
    state.updateBuffer("reply", { itemId: "second", occurrenceId: "empty", text: "Saved" });
    expect(state.resolveBuffer("reply").suppress).toBe(false);
    const baseline = state.resolveBuffer("reply").text;
    state.takeBufferDelta("reply", baseline);
    state.updateBuffer("reply", {
      ...(kind === "native" ? { itemId: "second", occurrenceId: "empty" } : {}),
      delta: "X",
    });
    const visible = state.resolveBuffer("reply").text;
    const delta = state.takeBufferDelta("reply", visible);
    const wire = delta?.replace ? delta.deltaText : baseline + (delta?.deltaText ?? "");
    expect([visible, wire]).toEqual(["Visible.\n\nX", "Visible.\n\nX"]);
  });

  it("retains commits received before text", () => {
    state.retireBuffer("reply", ["saved"]);
    state.updateBuffer("reply", { itemId: "saved", text: "Saved." });
    expectUpdate({ itemId: "tail", text: "Tail." }, "Tail.");
    expect(state.resolveBuffer("reply", { final: true })).toMatchObject({
      text: "Saved.\n\nTail.",
      displayText: "Tail.",
    });
  });

  it.each(["Saved.", "Saved.\n\n"])("corrects text after committed prefix %j", (prefix) => {
    state.updateBuffer("reply", { itemId: "saved", text: prefix });
    state.retireBuffer("reply", ["saved"]);
    state.takeBufferDelta("reply", "");
    expectUpdate({ itemId: "tail", text: "\n" }, "");
    expectUpdate({ itemId: "tail", delta: "\nDraft" }, "Draft");
    expectUpdate({ itemId: "tail", text: "Corrected", replace: true }, "Corrected");
    expect(state.takeBufferDelta("reply", "Corrected")).toEqual({
      deltaText: "Corrected",
      replace: true,
    });
  });

  it.each(["visible", "empty"])("retires owned bytes when %s commits first", (firstCommit) => {
    state.updateBuffer("reply", { itemId: "visible", text: "Saved." });
    state.updateBuffer("reply", { itemId: "empty", text: "", delta: "" });
    state.retireBuffer("reply", [firstCommit]);
    expect(state.resolveBuffer("reply").text).toBe(firstCommit === "visible" ? "" : "Saved.");
    state.retireBuffer("reply", [firstCommit === "visible" ? "empty" : "visible"]);
    expect(state.resolveBuffer("reply").text).toBe("");
  });

  it.each([undefined, "reused-display-id"])("separates occurrences (id=%s)", (itemId) => {
    const first: AgentAssistantSourceReceipt = {};
    const second: AgentAssistantSourceReceipt = {};
    state.updateBuffer("reply", { itemId, text: "Saved." }, first);
    first.committedMessageSeq = 2;
    state.retireSource("reply", first);
    state.updateBuffer("reply", { itemId, text: "Unsaved.", delta: "" }, second);
    expect(state.resolveBuffer("reply").text).toBe("Unsaved.");
    second.committedMessageSeq = 3;
    state.retireSource("reply", second);
    state.updateBuffer("reply", { itemId, text: "Corrected.", replace: true }, second);
    expect(state.resolveBuffer("reply").text).toBe("");
  });

  it.each([
    [true, false],
    [false, false],
    [true, true],
    [false, true],
  ])("retains unsaved text (identified=%s, committed=%s)", (identified, committedBeforeAppend) => {
    state.updateBuffer("reply", { ...(identified ? { itemId: "first" } : {}), text: "Unsaved." });
    state.updateBuffer("reply", { itemId: "second", text: "Saved." });
    if (committedBeforeAppend) {
      state.retireBuffer("reply", ["second"]);
    }
    let wire = state.resolveBuffer("reply").text;
    state.takeBufferDelta("reply", wire);
    state.updateBuffer("reply", { delta: "More." });
    if (!committedBeforeAppend) {
      state.retireBuffer("reply", ["second"]);
    }
    const delta = state.takeBufferDelta("reply", state.resolveBuffer("reply").text);
    if (delta) {
      wire = delta.replace ? delta.deltaText : wire + delta.deltaText;
    }
    expect(wire).toBe("Unsaved.\n\nMore.");
    expect(state.resolveBuffer("reply").text).toBe("Unsaved.\n\nMore.");
    if (identified) {
      state.retireBuffer("reply", ["first"]);
      expect(state.resolveBuffer("reply").text).toBe("More.");
    }
  });

  it.each([true, false])("retires bytes across append (before=%s)", (committedBefore) => {
    state.updateBuffer("reply", { itemId: "saved", text: "Saved." });
    state.takeBufferDelta("reply", "Saved.");
    if (committedBefore) {
      state.retireBuffer("reply", ["saved"]);
      state.takeBufferDelta("reply", "");
    }
    state.updateBuffer("reply", { delta: "More." });
    if (!committedBefore) {
      state.retireBuffer("reply", ["saved"]);
    }
    expect(state.resolveBuffer("reply").text).toBe("More.");
    expect(state.takeBufferDelta("reply", "More.")?.deltaText).toBe("More.");
  });

  it.each([false, true])("consumes late committed text (snapshot=%s)", (snapshot) => {
    state.updateBuffer("reply", { itemId: "first", text: "First" });
    state.takeBufferDelta("reply", "First");
    state.retireBuffer("reply", ["first"]);
    expect(state.takeBufferDelta("reply", "")).toEqual({ deltaText: "", replace: true });
    expect(state.resolveBuffer("reply", { final: true }).text).toBe("First");
    expectUpdate(
      { itemId: "first", delta: " note", ...(snapshot ? { text: "First note" } : {}) },
      "",
    );
    expect(state.resolveBuffer("reply", { final: true }).text).toBe("First note");
    expect(state.takeBufferDelta("reply", "")).toBeUndefined();
    expectUpdate({ itemId: "second", text: "Tail." }, "Tail.");
  });

  it("bounds parsing of growing literal directives", () => {
    const regions = vi.spyOn(codeRegions, "findCodeRegions");
    const ownership = vi.spyOn(codeRegions, "findCodeOwnership");
    const run = state.getOrCreate("reply");
    const literal = `The marker is ${directive}.\n\nNext paragraph.\n\n`;
    const block = "```ts\nconst value = 1;\n```\n\n";
    expectUpdate({ delta: literal }, literal);
    for (let index = 1; index <= 100; index++) {
      expectUpdate({ delta: block }, literal + block.repeat(index));
    }
    const calls = [...regions.mock.calls, ...ownership.mock.calls];
    const parsedChars = calls.reduce((total, [text]) => total + text.length, 0);
    expect(parsedChars).toBeLessThan((run.rawBuffer?.length ?? 0) * 4);
  });

  it("bounds code-point reads across consecutive messages", () => {
    const codePointAt = vi.spyOn(String.prototype, "codePointAt");
    const messages = 4;
    const chunks = 32;
    const delta = "word";
    for (let message = 0; message < messages; message++) {
      for (let chunk = 1; chunk <= chunks; chunk++) {
        state.updateBuffer("reply", {
          itemId: `message-${message}`,
          text: delta.repeat(chunk),
          delta,
        });
      }
    }
    expect(codePointAt.mock.calls.length).toBeLessThanOrEqual(messages * chunks * 2);
    codePointAt.mockRestore();
    expect(state.resolveBuffer("reply", { final: true }).text).toBe(
      Array.from({ length: messages }, () => delta.repeat(chunks)).join("\n\n"),
    );
  });

  it.each<[string, string, { deltaText: string; replace?: boolean }]>([
    ["Launch ", "🚀", { deltaText: "🚀" }],
    ["Launch \uD83D", "\uDE80", { deltaText: "Launch 🚀", replace: true }],
  ])("preserves code points after %j + %j", (first, delta, frame) => {
    state.updateBuffer("reply", { itemId: "answer", text: first, delta: first });
    state.takeBufferDelta("reply", state.resolveBuffer("reply").text);
    state.updateBuffer("reply", { itemId: "answer", text: "Launch 🚀", delta });
    expect(state.takeBufferDelta("reply", state.resolveBuffer("reply").text)).toEqual(frame);
  });

  it.each([
    {
      name: "closing backtick",
      frames: ["before `[[reply_to_current]]", `before ${directive} after`],
      visible: ["before `", `before ${directive} after`],
    },
    {
      name: "image reference",
      frames: [`![${directive}][x]\n\nnext`, `![${directive}][x]\n\nnext\n\n[x]: /image.png`],
      visible: [`![${directive}][x]\n\nnext`, "![``][x]\n\nnext\n\n[x]: /image.png"],
    },
    {
      name: "directive across append boundary",
      frames: [`${directive}\n\nNext [`, `${directive}\n\nNext [[reply_to_current]] after`],
      visible: [`${directive}\n\nNext`, `${directive}\n\nNext  after`],
    },
    {
      name: "replacement",
      frames: [`${directive}\n\nNext`, "[[reply_to_current]] visible"],
      visible: [`${directive}\n\nNext`, " visible"],
    },
  ])("reprojects Markdown after $name", ({ frames, visible }) => {
    let previous = "";
    frames.forEach((text, index) => {
      expectUpdate(
        {
          itemId: "answer",
          ...(text.startsWith(previous) ? { delta: text.slice(previous.length) } : { text }),
        },
        visible[index],
      );
      previous = text;
    });
  });

  it("isolates terminal tail release and clears retired projection", () => {
    const run = state.getOrCreate("reply");
    expectUpdate({ delta: `${directive}\n\nNext [` }, `${directive}\n\nNext`);
    expect(state.resolveBuffer("reply", { final: true }).text).toBe(run.rawBuffer);
    expect(state.resolveBuffer("reply").text).toBe(`${directive}\n\nNext`);
    state.clearRun("reply");
    expect(state.runs.has("reply")).toBe(false);
    expectUpdate({ delta: "[[reply_to_current]] visible" }, " visible");
  });

  it("retains pending deltas and reconciles terminal whitespace", () => {
    state.updateBuffer("reply", { delta: "N" });
    expect(state.resolveBuffer("reply").suppress).toBe(false);
    expect(state.takeBufferDelta("reply", "N")).toEqual({ deltaText: "N" });
    expectUpdate({ delta: "ice" }, "Nice");
    expectUpdate({ delta: " work " }, "Nice work ");
    expect(state.takeBufferDelta("reply", "Nice work ")).toEqual({ deltaText: "ice work " });
    expect(state.takeBufferDelta("reply", "Nice work ")).toBeUndefined();
    expect(state.takeBufferDelta("reply", "Nice work")).toEqual({
      deltaText: "Nice work",
      replace: true,
    });
    state.updateBuffer("reply", { delta: "again" });
    expect(state.takeBufferDelta("reply", "Nice work again")).toEqual({ deltaText: " again" });
  });

  it("reprojects managed media without leaking terminal tails", () => {
    const text = `${directive}\n\nPicture\nMEDIA:./plot.png\nDone`;
    expectUpdate({ delta: text }, text);
    expect(state.takeBufferDelta("reply", text)).toEqual({ deltaText: text });
    state.updateBuffer("reply", { managedMediaUrls: ["./plot.png"] });
    const visible = `${directive}\n\nPicture\nDone`;
    expect(state.resolveBuffer("reply").text).toBe(visible);
    expect(state.takeBufferDelta("reply", visible)).toEqual({ deltaText: visible, replace: true });
  });
});
