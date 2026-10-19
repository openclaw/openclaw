import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { INTERNAL_RUNTIME_CONTEXT_BEGIN } from "../agents/internal-runtime-context.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import {
  broadcastFor,
  createBroadcastPeer,
  type BroadcastFrame,
} from "./server-broadcast.test-support.js";
import { chatWireProjection } from "./server-chat-live-text.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";

const key = "agent:main:narrated";
type Frame = BroadcastFrame<{
  runId: string;
  sessionKey?: string;
  agentId?: string;
  text?: string;
  state?: string;
}>;
const peer = (connId: string) =>
  createBroadcastPeer<Frame["payload"]>(connId, true, {
    caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
  });

function chat(text: string, state = "delta", runId = "run") {
  return {
    sessionKey: key,
    runId,
    state,
    deltaText: text,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function harness() {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const narration = peer("narration");
  const foreground = peer("foreground");
  const subscribers = createSessionMessageSubscriberRegistry();
  subscribers.subscribe("narration", key, { mode: "narration" });
  subscribers.subscribe("foreground", key);
  let allowed = true;
  const broadcaster = broadcastFor([narration, foreground], {
    sessionMessageSubscribers: subscribers,
    canReceiveSessionEvent: () => allowed,
  });
  return {
    ...broadcaster,
    chat: (text: string, state = "delta", runId = "run", opts?: GatewayBroadcastOpts) =>
      broadcaster.broadcast("chat", chat(text, state, runId), opts),
    agent: (stream: string, data: Record<string, unknown>, runId = "run") =>
      broadcaster.broadcast("agent", { sessionKey: key, runId, stream, data }),
    narration,
    frames: narration.frames,
    foreground: foreground.frames,
    subscribers,
    revoke: () => {
      allowed = false;
    },
  };
}

const events = (frames: Frame[]) => frames.map(({ event }) => event);
const texts = (frames: Frame[]) => frames.map(({ payload }) => payload.text);

afterEach(() => vi.useRealTimers());
let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

it("paces background snapshots while preserving full foreground and lifecycle streams", () => {
  const deadlines = vi.spyOn(globalThis, "setTimeout");
  const run = new AbortController();
  const publish = (text: string, state = "delta") =>
    h.chat(text, state, "run", {
      liveText: {
        group: run.signal,
        projection:
          state === "delta"
            ? chatWireProjection({ key: "chat", text, now: Date.now() })
            : undefined,
      },
    });
  h.agent("lifecycle", { phase: "start" });
  publish("First sentence.");
  for (let index = 1; index <= 19; index += 1) {
    vi.advanceTimersByTime(100);
    h.agent("assistant", { text: `Raw ${index}` });
    publish(`Latest sentence ${index}.`);
  }
  expect(events(h.frames)).toEqual(["agent", "session.narration"]);
  expect(deadlines).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(100);
  expect(h.frames.at(-1)?.payload.text).toBe("Latest sentence 19.");
  expect(h.foreground.filter(({ event }) => event === "chat")).toHaveLength(20);
  expect(h.foreground.findLast(({ event }) => event === "chat")?.payload).not.toHaveProperty(
    "message",
  );
  expect(h.foreground.filter(({ event }) => event === "agent")).toHaveLength(20);
  publish("Final.", "final");
  expect(
    h.frames.slice(-2).map(({ event, payload }) => [event, payload.text ?? payload.state]),
  ).toEqual([
    ["session.narration", "Final."],
    ["chat", "final"],
  ]);
  vi.advanceTimersByTime(5_000);
  expect(h.frames.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
  run.abort();
});

it("bounds visible tails after stripping hidden blocks and immediately delivers final retractions", () => {
  h.chat(`Visible.\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${"private ".repeat(4_000)}`);
  expect(h.frames.at(-1)?.payload.text).toBe("Visible.");
  vi.advanceTimersByTime(2_000);
  h.chat(`Visible. <think>${"private ".repeat(4_000)}`);
  expect(h.frames.at(-1)?.payload.text?.trim()).toBe("Visible.");
  vi.advanceTimersByTime(2_000);
  h.chat(`${"x".repeat(20_000)}\n\nLatest line.`);
  expect(h.frames.at(-1)?.payload.text).toHaveLength(16_384);
  expect(h.frames.at(-1)?.payload.text).toMatch(/Latest line\.$/);
  h.chat("", "final");
  expect(h.frames.at(-2)?.payload.text).toBe("");
});

it("retires text superseded by tool activity without restarting its pacing window", () => {
  const tool = () => h.agent("tool", { phase: "start", name: "read" });
  h.chat("First.");
  vi.advanceTimersByTime(100);
  h.chat("Before the tool.");
  vi.advanceTimersByTime(100);
  tool();
  vi.advanceTimersByTime(1_800);
  expect(events(h.frames)).toEqual(["session.narration", "agent"]);

  h.chat("Assistant resumed.");
  vi.advanceTimersByTime(100);
  h.chat("Before another tool.");
  tool();
  h.chat("Latest assistant activity.");
  vi.advanceTimersByTime(1_899);
  expect(events(h.frames)).toEqual(["session.narration", "agent", "session.narration", "agent"]);
  vi.advanceTimersByTime(1);
  expect(h.frames.at(-1)?.payload.text).toBe("Latest assistant activity.");
  expect(h.foreground.filter(({ event }) => event === "chat")).toHaveLength(5);
});

it("does not let an older digest follow a new-run lifecycle event", () => {
  h.chat("First.");
  vi.advanceTimersByTime(100);
  h.chat("Queued from the previous run.");
  vi.advanceTimersByTime(100);
  h.agent("lifecycle", { phase: "start" }, "next");
  vi.advanceTimersByTime(1_800);
  expect(h.frames.map((frame) => [frame.event, frame.payload.runId])).toEqual([
    ["session.narration", "run"],
    ["agent", "next"],
  ]);
  h.chat("Next.", "delta", "next");
  expect(h.frames.at(-1)?.payload).toMatchObject({ runId: "next", text: "Next." });
});

it("omits token previews while retaining item completion, status, and tool events", () => {
  const hidden = [
    { stream: "thinking", data: { delta: "Private reasoning" } },
    { stream: "item", data: { phase: "update", kind: "preamble" } },
    { stream: "item", data: { phase: "update", kind: "answer_candidate", status: "candidate" } },
  ];
  const visible = [
    { stream: "item", data: { phase: "end", kind: "preamble" } },
    { stream: "item", data: { phase: "update", kind: "answer_candidate", status: "selected" } },
    { stream: "run_status", data: { phase: "starting_model" } },
    { stream: "tool", data: { phase: "start", name: "read" } },
  ];
  for (const { stream, data } of [...hidden, ...visible]) {
    h.agent(stream, data);
  }
  expect(h.foreground).toHaveLength(7);
  expect(h.frames).toMatchObject(visible.map((payload) => ({ payload })));
});

it.each(["revocation", "close", "retirement"] as const)("retires narration on %s", (reason) => {
  const run = new AbortController();
  const opts = { liveText: { group: run.signal } };
  h.chat("First.", "delta", "run", opts);
  h.chat("Pending.", "delta", "run", opts);
  if (reason === "revocation") {
    h.revoke();
  }
  if (reason === "close") {
    h.narration.socket.readyState = 3;
    h.narration.socket.emit("close");
  }
  if (reason === "retirement") {
    run.abort();
  }
  vi.advanceTimersByTime(2_000);
  expect(h.frames).toHaveLength(1);
  run.abort();
});

it("keeps full alias delivery and flushes pending narration before errors", () => {
  const sibling = "agent:main:sibling";
  h.subscribers.subscribe("narration", sibling);
  h.chat("Full alias.", "delta", "run", { sessionKeys: [key, sibling] });
  expect(h.frames.at(-1)?.event).toBe("chat");
  h.chat("First session.");
  h.chat("Last partial.");
  h.broadcast("chat", {
    sessionKey: key,
    runId: "run",
    state: "error",
  });
  expect(events(h.frames.slice(-2))).toEqual(["session.narration", "chat"]);
  expect(h.frames.at(-2)?.payload.text).toBe("Last partial.");
});

it("separates logical global sessions and retires every state for a released wire key", () => {
  const mainKey = "agent:main:global";
  const opsKey = "agent:ops:global";
  h.subscribers.subscribe("narration", mainKey, { subscriptionId: "raw", mode: "narration" });
  h.subscribers.subscribe("narration", mainKey, { subscriptionId: "literal", mode: "narration" });
  h.subscribers.subscribe("narration", opsKey, { subscriptionId: "ops", mode: "narration" });
  const initial = { ...chat("Initial."), sessionKey: "global" };
  h.broadcast("chat", initial, { sessionKeys: [mainKey], agentId: "main" });
  h.broadcast("chat", { ...initial, sessionKey: mainKey }, { sessionKeys: [mainKey] });
  h.broadcast("chat", initial, { sessionKeys: [opsKey], agentId: "ops" });
  expect(
    h.frames.map(({ payload }) => [payload.sessionKey, payload.agentId, payload.text]),
  ).toEqual([
    ["global", "main", "Initial."],
    [mainKey, "main", "Initial."],
    ["global", "ops", "Initial."],
  ]);

  const publish = (sessionKey: string, agentId: string, text: string) =>
    h.broadcast(
      "chat",
      { ...chat(text), sessionKey, agentId },
      { sessionKeys: [`agent:${agentId}:global`] },
    );
  vi.advanceTimersByTime(100);
  publish("global", "main", "Raw pending.");
  publish(mainKey, "main", "Literal pending.");
  publish("global", "ops", "Ops pending.");
  h.broadcast(
    "session.tool",
    { sessionKey: "global", runId: "run", stream: "tool", data: { name: "read" } },
    { sessionKeys: [mainKey], agentId: "main" },
  );
  vi.advanceTimersByTime(1_900);
  expect(texts(h.frames.slice(-2))).toEqual(["Literal pending.", "Ops pending."]);
  expect(h.frames).toHaveLength(6);

  publish("global", "main", "Raw resumed.");
  vi.advanceTimersByTime(100);
  publish("global", "main", "raw");
  publish(mainKey, "main", "literal");
  publish("global", "ops", "ops");
  h.subscribers.unsubscribe("narration", mainKey, "raw");
  vi.advanceTimersByTime(1_900);
  expect(texts(h.frames.slice(-3))).toEqual(["raw", "literal", "ops"]);
  expect(h.frames).toHaveLength(10);

  publish("global", "main", "Raw retired on final release.");
  publish(mainKey, "main", "Literal retired on final release.");
  h.subscribers.unsubscribe("narration", mainKey, "literal");
  publish("global", "ops", "Retired on foreground admission.");
  h.subscribers.subscribe("narration", opsKey, { subscriptionId: "ops" });
  vi.advanceTimersByTime(2_000);
  expect(h.frames).toHaveLength(10);
  publish("global", "ops", "Full transcript.");
  expect(h.frames.at(-1)?.event).toBe("chat");
});
