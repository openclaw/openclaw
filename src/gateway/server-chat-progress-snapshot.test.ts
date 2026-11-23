import { expect, it, vi } from "vitest";
import { projectInFlightRunSnapshot } from "./chat-inflight-snapshot.js";
import { createChatRunState } from "./server-chat-state.js";

it.each(["full", "summary"] as const)(
  "retains only scheduler identity when %s recovery omits tool payloads",
  (mode) => {
    const state = createChatRunState();
    const args = { action: "add", planId: "p", slotId: "s" };
    const receipt = {
      type: "automation_creation_result",
      planId: "p",
      slotId: "s",
      status: "created",
      jobId: "saved",
    };
    const privateBody = "private".repeat(16_000);
    const event = { runId: "r", stream: "tool" as const, ts: 1 };
    state.recordProgressEvent(
      "r",
      {
        ...event,
        seq: 1,
        data: {
          phase: "start",
          name: "automations",
          toolCallId: "call",
          args: { ...args, job: { body: privateBody } },
        },
      },
      mode,
    );
    state.recordProgressEvent(
      "r",
      {
        ...event,
        seq: 2,
        data: {
          phase: "result",
          name: "automations",
          toolCallId: "call",
          isError: false,
          result: { details: { automationCreation: receipt, body: privateBody } },
        },
      },
      mode,
    );
    const events = projectInFlightRunSnapshot({ chatRunState: state, runId: "r" }).events;
    expect(events?.map((e) => e.data)).toEqual([
      { phase: "start", name: "automations", toolCallId: "call", args },
      {
        phase: "result",
        name: "automations",
        toolCallId: "call",
        isError: false,
        result: { details: { automationCreation: receipt } },
      },
    ]);
  },
);

it("defers output replay decoding until recovery without rereading producers", () => {
  const state = createChatRunState();
  const tool = (seq: number, phase: string, toolCallId: string, data: Record<string, unknown>) =>
    state.recordProgressEvent("run-1", {
      runId: "run-1",
      seq,
      ts: seq,
      stream: "tool",
      data: { phase, toolCallId, ...data },
    });
  let text = "";
  let serializations = 0;
  let reads = 0;
  const partialResult = {
    toJSON: () => {
      serializations += 1;
      return {
        get text() {
          reads += 1;
          return text;
        },
        liveOutput: { text: "latest tail", omittedChars: 10_000 },
      };
    },
  };
  using decoding = vi.spyOn(JSON, "parse");
  for (let seq = 1; seq <= 3; seq += 1) {
    text = `accepted ${seq}`;
    tool(seq, "update", "command", { name: "exec", outputOnly: true, partialResult });
  }
  const outputDecodes = () =>
    decoding.mock.calls.filter(([json]) => json.includes('"outputOnly":true')).length;
  expect(outputDecodes()).toBe(0);
  expect([serializations, reads]).toEqual([3, 3]);
  text = "changed after receipt";
  const replay = () => projectInFlightRunSnapshot({ chatRunState: state, runId: "run-1" }).events;
  const events = replay();
  expect(events).toMatchObject([
    {
      seq: 3,
      data: {
        outputOnly: true,
        partialResult: {
          text: "accepted 3",
          liveOutput: { text: "latest tail", omittedChars: 10_000 },
        },
      },
    },
  ]);
  expect(state.runs.get("run-1")?.progressSnapshot?.byteLength).toBe(
    Buffer.byteLength(JSON.stringify(events?.[0])),
  );
  expect(outputDecodes()).toBe(1);
  const captured = events![0]!.data.partialResult as { text: string };
  expect(Reflect.set(captured, "text", "mutated replay")).toBe(false);
  expect(replay()).toEqual(events);
  expect(outputDecodes()).toBe(2);
  expect([serializations, reads]).toEqual([3, 3]);
  tool(2, "update", "command", { outputOnly: true, partialResult: "stale" });
  expect(replay()).toEqual(events);
  state.clearRun("run-1");
  expect(replay()).toBeUndefined();
});

it("retains canonical immutable output without encoding or decoding a recovery copy", () => {
  const state = createChatRunState();
  const text = '"\\\n\u0000é🦞\ud800';
  const outputs = [
    Object.freeze({ text }),
    Object.freeze({ text, liveOutput: Object.freeze({ text: "tail\n", omittedChars: 12_000 }) }),
  ];
  for (const [index, partialResult] of outputs.entries()) {
    using encoding = vi.spyOn(JSON, "stringify");
    using decoding = vi.spyOn(JSON, "parse");
    state.recordProgressEvent("immutable-run", {
      runId: "immutable-run",
      seq: index + 1,
      ts: index + 1,
      stream: "tool",
      data: { phase: "update", toolCallId: "command", outputOnly: true, partialResult },
    });
    const events = projectInFlightRunSnapshot({
      chatRunState: state,
      runId: "immutable-run",
    }).events;
    expect(
      encoding.mock.calls.filter(([value]) => value !== null && typeof value === "object"),
    ).toHaveLength(0);
    expect(decoding).not.toHaveBeenCalled();
    encoding.mockRestore();
    expect(events).toMatchObject([{ seq: index + 1, data: { partialResult } }]);
    expect(state.runs.get("immutable-run")?.progressSnapshot?.byteLength).toBe(
      Buffer.byteLength(JSON.stringify(events![0])),
    );
    expect(Reflect.set(events![0]!.data, "partialResult", {})).toBe(false);
  }
});

it("keeps the exact recovery byte limit for canonical immutable output", () => {
  const state = createChatRunState();
  const metadata = { phase: "update", toolCallId: "command", outputOnly: true };
  const event = (seq: number, text: string) => ({
    runId: "limit-run",
    seq,
    ts: seq,
    stream: "tool",
    data: { ...metadata, partialResult: Object.freeze({ text }) },
  });
  const prefix = '\n"\\é🦞\ud800';
  const text = prefix + "x".repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(event(1, prefix))));
  state.recordProgressEvent("limit-run", event(1, text));
  const replay = () =>
    projectInFlightRunSnapshot({ chatRunState: state, runId: "limit-run" }).events;
  expect(state.runs.get("limit-run")?.progressSnapshot?.byteLength).toBe(64 * 1024);
  expect(replay()![0]!.data.partialResult).toEqual({ text });
  state.recordProgressEvent("limit-run", event(2, `${text}x`));
  expect(replay()![0]!.data).toEqual(metadata);
});

it.each([
  Object.freeze({ text: "value", omitted: undefined }),
  Object.freeze({ text: "value", liveOutput: Object.freeze({ text: "tail", omittedChars: -0 }) }),
  Object.freeze(Object.defineProperty({}, "text", { value: "hidden" })),
  Object.freeze({
    get text() {
      return "getter";
    },
  }),
  Object.freeze({ text: "native", toJSON: () => ({ text: "transformed" }) }),
])("keeps native JSON normalization for noncanonical frozen output (%j)", (partialResult) => {
  const state = createChatRunState();
  state.recordProgressEvent("generic-run", {
    runId: "generic-run",
    seq: 1,
    ts: 1,
    stream: "tool",
    data: { phase: "update", toolCallId: "command", outputOnly: true, partialResult },
  });
  const events = projectInFlightRunSnapshot({ chatRunState: state, runId: "generic-run" }).events;
  const captured = events![0]!.data.partialResult;
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Native JSON normalization is the recovery contract under test.
  const expected = JSON.parse(JSON.stringify(partialResult));
  expect(captured).toStrictEqual(expected);
  if (!captured || typeof captured !== "object") {
    throw new Error("Expected captured output record");
  }
  expect(Reflect.ownKeys(captured)).toEqual(Reflect.ownKeys(expected));
  expect(Object.getOwnPropertyDescriptor(captured, "text") ?? {}).not.toHaveProperty("get");
  expect(state.runs.get("generic-run")?.progressSnapshot?.byteLength).toBe(
    Buffer.byteLength(JSON.stringify(events![0])),
  );
});

// The owner has detached these flat fields; native JSON has nothing left to normalize.
it("retains scalar progress without encoding a recovery copy", () => {
  const state = createChatRunState();
  const data = {
    phase: "warning",
    message: 'Ready\n"é🦞',
    count: 12,
    pending: false,
    detail: null,
  };
  using encoding = vi.spyOn(JSON, "stringify");
  using decoding = vi.spyOn(JSON, "parse");
  state.recordProgressEvent("scalar-run", {
    runId: "scalar-run",
    seq: 1,
    ts: 1,
    stream: "notice",
    data,
  });
  data.message = "producer changed";
  const events = projectInFlightRunSnapshot({ chatRunState: state, runId: "scalar-run" }).events;
  expect(encoding.mock.calls.filter(([value]) => typeof value === "object")).toHaveLength(0);
  expect(decoding).not.toHaveBeenCalled();
  encoding.mockRestore();
  expect(events?.[0]?.data).toEqual({ ...data, message: 'Ready\n"é🦞' });
  expect(Reflect.set(events![0]!.data, "message", "reader changed")).toBe(false);
  expect(state.runs.get("scalar-run")?.progressSnapshot?.byteLength).toBe(
    Buffer.byteLength(JSON.stringify(events![0])),
  );
  // Native JSON drops symbol keys even when their values are canonical scalars.
  state.recordProgressEvent("scalar-run", {
    runId: "scalar-run",
    seq: 2,
    ts: 2,
    stream: "notice",
    data: { phase: "warning", message: "next", [Symbol("producer")]: "ignored" },
  });
  const next = projectInFlightRunSnapshot({ chatRunState: state, runId: "scalar-run" }).events!.at(
    -1,
  )!;
  expect(Reflect.ownKeys(next.data)).toEqual(["phase", "message"]);
});

it.each([Number.NaN, Infinity, -Infinity, -0, undefined, Symbol("omitted")])(
  "normalizes noncanonical scalar progress (%s)",
  (value) => {
    const state = createChatRunState();
    state.recordProgressEvent("scalar-run", {
      runId: "scalar-run",
      seq: 1,
      ts: 1,
      stream: "notice",
      data: { phase: "warning", value },
    });
    const events = projectInFlightRunSnapshot({ chatRunState: state, runId: "scalar-run" }).events;
    const expected = typeof value === "number" ? { value: Object.is(value, -0) ? 0 : null } : {};
    expect(events?.[0]?.data).toStrictEqual({ phase: "warning", ...expected });
  },
);
