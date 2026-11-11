import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentEventSchema } from "../../packages/gateway-protocol/src/schema/agent.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";

let h: ReturnType<typeof createAgentEventTestHarness>;
beforeEach(() => {
  vi.useFakeTimers();
  h = createAgentEventTestHarness();
  h.register("run", "main", "run");
});
afterEach(async () => {
  try {
    await h.handler.dispose();
  } finally {
    h.chatRunState.clear();
    vi.useRealTimers();
  }
});

function preambleEvent(seq: number, data: AgentEventRuntimePayload["data"], retained: string) {
  return Object.defineProperty(
    { runId: "run", seq, ts: Date.now(), stream: "item", data },
    "assistantProjection",
    { value: { itemId: "message", text: retained, replace: true } },
  );
}
const preamble = (itemId: string, phase: string, progressText: string) => ({
  kind: "preamble",
  itemId,
  phase,
  progressText,
});

it.each(["", "First answer."])(
  "publishes the retained preamble projection: %j",
  async (retained) => {
    const text = retained ? `${retained}\n\nChecking again.` : "Checking again.";
    await h.emit("run", "assistant", { itemId: "message", text, delta: text }, { seq: 1 });
    const event = preambleEvent(2, preamble("commentary", "end", "Checking again."), retained);
    await h.handler(event);
    h.chatRunState.flushPendingText("run");
    const payload = h.agent().at(-1)?.[1];
    expect(payload).toMatchObject({ stream: "item", preamble: { retainedText: retained } });
    expect(h.chatRunState.resolveBuffer("run").text).toBe(retained);
    const { sessionKey: _sessionKey, agentId: _agentId, ...wire } = payload;
    const { preamble: _preamble, ...legacy } = wire;
    expect([
      Value.Check(AgentEventSchema, wire),
      Value.Check(AgentEventSchema, legacy),
      Value.Check(AgentEventSchema, { ...wire, preamble: { retainedText: 42 } }),
    ]).toEqual([true, true, false]);

    await h.emit("run", "item", preamble("known", "end", "Next check."), { seq: 3 });
    expect(h.agent().at(-1)?.[1]).toMatchObject({ preamble: {} });
    expect(h.chatRunState.resolveBuffer("run").text).toBe(retained);
  },
);

it("preserves the projection when paced preamble snapshots coalesce", async () => {
  await h.emit("run", "item", preamble("previous", "update", "Previous check."));
  const event = preambleEvent(2, preamble("current", "update", "Checking"), "");
  await h.handler(event);
  await h.emit("run", "item", { ...event.data, progressText: "Checking again." }, { seq: 3 });
  await h.emit(
    "run",
    "item",
    { ...event.data, phase: "end", progressText: "Checking again." },
    { seq: 4 },
  );
  expect(
    h
      .agent()
      .map(([, payload]) => payload)
      .filter((payload) => payload.data.itemId === "current"),
  ).toMatchObject([
    {
      data: { phase: "update", progressText: "Checking again." },
      preamble: { retainedText: "" },
    },
    { data: { phase: "end", progressText: "Checking again." }, preamble: {} },
  ]);
});
