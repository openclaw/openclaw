import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { INTERNAL_RUNTIME_CONTEXT_BEGIN } from "../agents/internal-runtime-context.js";
import { broadcastFor, createBroadcastPeer } from "./server-broadcast.test-support.js";
import { chatWireProjection } from "./server-chat-live-text.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";

const key = "agent:main:narrated";
const peer = (id: string) =>
  createBroadcastPeer<{
    runId: string;
    sessionKey?: string;
    agentId?: string;
    text?: string;
    state?: string;
  }>(id, true, { caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS] });
const activity = (stream: string, data: unknown, runId = "run") => ({
  sessionKey: key,
  runId,
  stream,
  data,
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
    narration,
    foreground,
    subscribers,
    events: () => narration.frames.map(({ event }) => event),
    texts: () => narration.frames.map(({ payload }) => payload.text),
    last: () => narration.frames.at(-1)?.payload,
    publish: (text: string, state = "delta", runId = "run") =>
      broadcaster.broadcast("chat", chat(text, state, runId)),
    revoke: () => {
      allowed = false;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("narration delivery through the Gateway broadcaster", () => {
  it.each(["agent", "session.tool"])(
    "omits unused tool bodies from %s narration while preserving full subscribers",
    (event) => {
      const h = harness();
      const data = {
        phase: "result",
        name: "exec",
        toolCallId: "tool-1",
        parentToolCallId: "parent-1",
        hideFromChannelProgress: true,
        isError: true,
        args: { command: "synthetic command" },
        diff: "streamed input",
        partialResult: { content: [{ type: "text", text: "partial output" }] },
        result: { content: [{ type: "text", text: "complete output" }] },
      };
      const payload = { sessionKey: key, runId: "run", stream: "tool", data };
      const publish = () => h.broadcast(event, payload);
      publish();
      expect(h.narration.frames[0]?.payload).toEqual({
        ...payload,
        data: {
          phase: "result",
          name: "exec",
          toolCallId: "tool-1",
          parentToolCallId: "parent-1",
          hideFromChannelProgress: true,
          isError: true,
        },
      });
      expect(h.foreground.frames[0]?.payload).toEqual(payload);
      // Opening chat admits full delivery before its history snapshot; closing
      // it restores narration while the sidebar's independent lease remains.
      h.subscribers.subscribe("narration", key, { subscriptionId: "chat" });
      publish();
      expect(h.narration.frames[1]?.payload).toEqual(payload);
      h.subscribers.unsubscribe("narration", key, "chat");
      publish();
      expect(h.narration.frames[2]?.payload).toEqual(h.narration.frames[0]?.payload);
      expect(h.narration.frames.map(({ seq }) => seq)).toEqual([1, 2, 3]);
      expect(h.foreground.frames.map(({ payload: received }) => received)).toEqual([
        payload,
        payload,
        payload,
      ]);
    },
  );

  it("paces background snapshots while preserving full foreground and lifecycle streams", () => {
    const h = harness();
    const deadlines = vi.spyOn(globalThis, "setTimeout");
    const run = new AbortController();
    const publish = (text: string, state = "delta") =>
      h.broadcast("chat", chat(text, state), {
        liveText: {
          group: run.signal,
          projection:
            state === "delta"
              ? chatWireProjection({ key: "chat", text, now: Date.now() })
              : undefined,
        },
      });
    h.broadcast("agent", activity("lifecycle", { phase: "start" }));
    publish("First sentence.");
    for (let index = 1; index <= 19; index += 1) {
      vi.advanceTimersByTime(100);
      h.broadcast("agent", activity("assistant", { text: `Raw ${index}` }));
      publish(`Latest sentence ${index}.`);
    }
    expect(h.events()).toEqual(["agent", "session.narration"]);
    expect(deadlines).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(h.last()?.text).toBe("Latest sentence 19.");
    expect(h.foreground.frames.filter(({ event }) => event === "chat")).toHaveLength(20);
    expect(
      h.foreground.frames.findLast(({ event }) => event === "chat")?.payload,
    ).not.toHaveProperty("message");
    expect(h.foreground.frames.filter(({ event }) => event === "agent")).toHaveLength(20);
    publish("Final corrected sentence.", "final");
    expect(
      h.narration.frames
        .slice(-2)
        .map(({ event, payload }) => [event, payload.text ?? payload.state]),
    ).toEqual([
      ["session.narration", "Final corrected sentence."],
      ["chat", "final"],
    ]);
    vi.advanceTimersByTime(5_000);
    expect(h.narration.frames).toHaveLength(5);
    expect(h.narration.frames.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
    run.abort();
  });

  it("bounds visible tails after stripping hidden blocks and immediately delivers final retractions", () => {
    const h = harness();
    h.publish(`Visible.\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${"private ".repeat(4_000)}`);
    expect(h.last()?.text).toBe("Visible.");
    vi.advanceTimersByTime(2_000);
    h.publish(`Visible. <think>${"private ".repeat(4_000)}`);
    expect(h.last()?.text?.trim()).toBe("Visible.");
    vi.advanceTimersByTime(2_000);
    h.publish(`${"x".repeat(20_000)}\n\nLatest line.`);
    expect(h.last()?.text).toHaveLength(16_384);
    expect(h.last()?.text).toMatch(/Latest line\.$/);
    h.publish("", "final");
    expect(h.narration.frames.at(-2)?.payload.text).toBe("");
  });

  it("retires text superseded by tool activity without restarting its pacing window", () => {
    const h = harness();
    const tool = () => h.broadcast("agent", activity("tool", { phase: "start", name: "read" }));
    h.publish("First.");
    vi.advanceTimersByTime(100);
    h.publish("Before the tool.");
    vi.advanceTimersByTime(100);
    tool();
    vi.advanceTimersByTime(1_800);
    expect(h.events()).toEqual(["session.narration", "agent"]);

    h.publish("Assistant resumed.");
    vi.advanceTimersByTime(100);
    h.publish("Before another tool.");
    tool();
    h.publish("Latest assistant activity.");
    vi.advanceTimersByTime(1_899);
    expect(h.events()).toEqual(["session.narration", "agent", "session.narration", "agent"]);
    vi.advanceTimersByTime(1);
    expect(h.last()?.text).toBe("Latest assistant activity.");
    expect(h.foreground.frames.filter(({ event }) => event === "chat")).toHaveLength(5);
  });

  it("does not let an older digest follow a new-run lifecycle event", () => {
    const h = harness();
    h.publish("First.");
    vi.advanceTimersByTime(100);
    h.publish("Queued from the previous run.");
    vi.advanceTimersByTime(100);
    h.broadcast("agent", activity("lifecycle", { phase: "start" }, "next-run"));
    vi.advanceTimersByTime(1_800);
    expect(h.narration.frames.map((frame) => [frame.event, frame.payload.runId])).toEqual([
      ["session.narration", "run"],
      ["agent", "next-run"],
    ]);
    h.publish("New run progress.", "delta", "next-run");
    expect(h.last()).toMatchObject({
      runId: "next-run",
      text: "New run progress.",
    });
  });

  it("omits token previews while retaining item completion, status, and tool events", () => {
    const h = harness();
    const hidden = [
      activity("thinking", { delta: "Private reasoning" }),
      activity("item", { phase: "update", kind: "preamble", progressText: "Working" }),
      activity("item", {
        phase: "update",
        kind: "answer_candidate",
        status: "candidate",
        progressText: "Draft",
      }),
    ];
    const visible = [
      activity("item", { phase: "end", kind: "preamble" }),
      activity("item", { phase: "update", kind: "answer_candidate", status: "selected" }),
      activity("run_status", { phase: "starting_model" }),
      activity("tool", { phase: "start", name: "read" }),
    ];
    for (const payload of [...hidden, ...visible]) {
      h.broadcast("agent", payload);
    }
    expect(h.foreground.frames).toHaveLength(7);
    expect(h.narration.frames.map(({ payload }) => payload)).toEqual(visible);
  });

  it.each(["revocation", "close", "retirement"] as const)(
    "never delivers queued narration after %s",
    (reason) => {
      const h = harness();
      const run = new AbortController();
      const opts = { liveText: { group: run.signal } };
      h.broadcast("chat", chat("First."), opts);
      h.broadcast("chat", chat("Pending."), opts);
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
      expect(h.narration.frames).toHaveLength(1);
      run.abort();
    },
  );

  it("keeps full delivery when any matching subscription is full and isolates session pacing", () => {
    const h = harness();
    const sibling = "agent:main:sibling";
    h.subscribers.subscribe("narration", sibling);
    h.broadcast("chat", chat("Full alias."), { sessionKeys: [key, sibling] });
    expect(h.narration.frames.at(-1)?.event).toBe("chat");
    h.subscribers.subscribe("narration", sibling, { mode: "narration" });
    h.publish("First session.");
    h.broadcast("chat", { ...chat("Second session."), sessionKey: sibling });
    expect(h.texts().slice(-2)).toEqual(["First session.", "Second session."]);
    h.publish("Last partial.");
    h.broadcast("chat", {
      sessionKey: key,
      runId: "run",
      state: "error",
      errorMessage: "Stopped.",
    });
    expect(h.events().slice(-2)).toEqual(["session.narration", "chat"]);
    expect(h.narration.frames.at(-2)?.payload.text).toBe("Last partial.");
  });

  it("separates logical global sessions and retires every state for a released wire key", () => {
    const h = harness();
    const mainKey = "agent:main:global";
    const opsKey = "agent:ops:global";
    h.subscribers.subscribe("narration", mainKey, { subscriptionId: "raw", mode: "narration" });
    h.subscribers.subscribe("narration", mainKey, {
      subscriptionId: "literal",
      mode: "narration",
    });
    h.subscribers.subscribe("narration", opsKey, { subscriptionId: "ops", mode: "narration" });
    const initial = { ...chat("Initial."), sessionKey: "global" };
    h.broadcast("chat", initial, { sessionKeys: [mainKey], agentId: "main" });
    h.broadcast("chat", { ...initial, sessionKey: mainKey }, { sessionKeys: [mainKey] });
    h.broadcast("chat", initial, { sessionKeys: [opsKey], agentId: "ops" });
    expect(
      h.narration.frames.map(({ payload }) => [payload.sessionKey, payload.agentId, payload.text]),
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
    expect(h.texts().slice(-2)).toEqual(["Literal pending.", "Ops pending."]);
    expect(h.narration.frames).toHaveLength(6);

    publish("global", "main", "Raw resumed.");
    vi.advanceTimersByTime(100);
    publish("global", "main", "Raw retired.");
    publish(mainKey, "main", "Literal retired.");
    publish("global", "ops", "Ops retained.");
    h.subscribers.unsubscribe("narration", mainKey, "raw");
    vi.advanceTimersByTime(1_900);
    expect(h.texts().slice(-3)).toEqual(["Raw retired.", "Literal retired.", "Ops retained."]);
    expect(h.narration.frames).toHaveLength(10);

    publish("global", "main", "Raw retired on final release.");
    publish(mainKey, "main", "Literal retired on final release.");
    h.subscribers.unsubscribe("narration", mainKey, "literal");
    publish("global", "ops", "Retired on foreground admission.");
    h.subscribers.subscribe("narration", opsKey, { subscriptionId: "ops" });
    vi.advanceTimersByTime(2_000);
    expect(h.narration.frames).toHaveLength(10);
    publish("global", "ops", "Full transcript.");
    expect(h.narration.frames.at(-1)?.event).toBe("chat");
  });
});
