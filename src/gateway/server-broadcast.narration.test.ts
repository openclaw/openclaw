import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { INTERNAL_RUNTIME_CONTEXT_BEGIN } from "../agents/internal-runtime-context.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { chatWireProjection } from "./server-chat-live-text.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const key = "agent:main:narrated";
type Frame = {
  event: string;
  seq: number;
  payload: { runId: string; sessionKey?: string; agentId?: string; text?: string; state?: string };
};

function peer(connId: string) {
  const frames: Frame[] = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    close: vi.fn(),
    terminate: vi.fn(),
    send: (
      wire: string | Buffer,
      options?: { binary: false } | (() => void),
      done?: () => void,
    ) => {
      frames.push(JSON.parse(String(wire)));
      (typeof options === "function" ? options : done)?.();
    },
  });
  const client: GatewayWsClient = {
    connId,
    socket: socket as unknown as GatewayWsClient["socket"],
    connect: {
      role: "operator",
      scopes: ["operator.read"],
      caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS],
    } as GatewayWsClient["connect"],
    usesSharedGatewayAuth: false,
  };
  return { client, socket, frames };
}

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
  const clients = new GatewayClientRegistry([narration.client, foreground.client]);
  const subscribers = createSessionMessageSubscriberRegistry();
  subscribers.subscribe("narration", key, { mode: "narration" });
  subscribers.subscribe("foreground", key);
  let allowed = true;
  const broadcaster = createGatewayBroadcaster({
    clients,
    sessionMessageSubscribers: subscribers,
    canReceiveSessionEvent: () => allowed,
  });
  return {
    ...broadcaster,
    narration,
    foreground,
    subscribers,
    clients,
    revoke: () => {
      allowed = false;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("narration delivery through the Gateway broadcaster", () => {
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
    h.broadcast("agent", {
      sessionKey: key,
      runId: "run",
      stream: "lifecycle",
      data: { phase: "start" },
    });
    publish("First sentence.");
    for (let index = 1; index <= 19; index += 1) {
      vi.advanceTimersByTime(100);
      h.broadcast("agent", {
        sessionKey: key,
        runId: "run",
        stream: "assistant",
        data: { text: `Raw ${index}` },
      });
      publish(`Latest sentence ${index}.`);
    }
    expect(h.narration.frames.map(({ event }) => event)).toEqual(["agent", "session.narration"]);
    expect(deadlines).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(h.narration.frames.at(-1)?.payload.text).toBe("Latest sentence 19.");
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
    h.broadcast(
      "chat",
      chat(`Visible.\n${INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${"private ".repeat(4_000)}`),
    );
    expect(h.narration.frames.at(-1)?.payload.text).toBe("Visible.");
    vi.advanceTimersByTime(2_000);
    h.broadcast("chat", chat(`Visible. <think>${"private ".repeat(4_000)}`));
    expect(h.narration.frames.at(-1)?.payload.text?.trim()).toBe("Visible.");
    vi.advanceTimersByTime(2_000);
    h.broadcast("chat", chat(`${"x".repeat(20_000)}\n\nLatest line.`));
    expect(h.narration.frames.at(-1)?.payload.text).toHaveLength(16_384);
    expect(h.narration.frames.at(-1)?.payload.text).toMatch(/Latest line\.$/);
    h.broadcast("chat", chat("", "final"));
    expect(h.narration.frames.at(-2)?.payload.text).toBe("");
  });

  it("retires text superseded by tool activity without restarting its pacing window", () => {
    const h = harness();
    const tool = () =>
      h.broadcast("agent", {
        sessionKey: key,
        runId: "run",
        stream: "tool",
        data: { phase: "start", name: "read" },
      });
    h.broadcast("chat", chat("First."));
    vi.advanceTimersByTime(100);
    h.broadcast("chat", chat("Before the tool."));
    vi.advanceTimersByTime(100);
    tool();
    vi.advanceTimersByTime(1_800);
    expect(h.narration.frames.map(({ event }) => event)).toEqual(["session.narration", "agent"]);

    h.broadcast("chat", chat("Assistant resumed."));
    vi.advanceTimersByTime(100);
    h.broadcast("chat", chat("Before another tool."));
    tool();
    h.broadcast("chat", chat("Latest assistant activity."));
    vi.advanceTimersByTime(1_899);
    expect(h.narration.frames.map(({ event }) => event)).toEqual([
      "session.narration",
      "agent",
      "session.narration",
      "agent",
    ]);
    vi.advanceTimersByTime(1);
    expect(h.narration.frames.at(-1)?.payload.text).toBe("Latest assistant activity.");
    expect(h.foreground.frames.filter(({ event }) => event === "chat")).toHaveLength(5);
  });

  it("does not let an older digest follow a new-run lifecycle event", () => {
    const h = harness();
    h.broadcast("chat", chat("First."));
    vi.advanceTimersByTime(100);
    h.broadcast("chat", chat("Queued from the previous run."));
    vi.advanceTimersByTime(100);
    h.broadcast("agent", {
      stream: "lifecycle",
      data: { phase: "start" },
      sessionKey: key,
      runId: "next-run",
    });
    vi.advanceTimersByTime(1_800);
    expect(h.narration.frames.map((frame) => [frame.event, frame.payload.runId])).toEqual([
      ["session.narration", "run"],
      ["agent", "next-run"],
    ]);
    h.broadcast("chat", chat("New run progress.", "delta", "next-run"));
    expect(h.narration.frames.at(-1)?.payload).toMatchObject({
      runId: "next-run",
      text: "New run progress.",
    });
  });

  it("omits token previews while retaining item completion, status, and tool events", () => {
    const h = harness();
    for (const payload of [
      { stream: "thinking", data: { delta: "Private reasoning" } },
      { stream: "item", data: { phase: "update", kind: "preamble", progressText: "Working" } },
      {
        stream: "item",
        data: {
          phase: "update",
          kind: "answer_candidate",
          status: "candidate",
          progressText: "Draft",
        },
      },
      { stream: "item", data: { phase: "end", kind: "preamble" } },
      { stream: "item", data: { phase: "update", kind: "answer_candidate", status: "selected" } },
      { stream: "run_status", data: { phase: "starting_model" } },
      { stream: "tool", data: { phase: "start", name: "read" } },
    ]) {
      h.broadcast("agent", { ...payload, sessionKey: key, runId: "run" });
    }
    expect(h.foreground.frames).toHaveLength(7);
    expect(h.narration.frames).toMatchObject([
      { payload: { stream: "item", data: { phase: "end", kind: "preamble" } } },
      {
        payload: {
          stream: "item",
          data: { phase: "update", kind: "answer_candidate", status: "selected" },
        },
      },
      { payload: { stream: "run_status", data: { phase: "starting_model" } } },
      { payload: { stream: "tool", data: { phase: "start", name: "read" } } },
    ]);
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
    h.broadcast("chat", chat("First session."));
    h.broadcast("chat", { ...chat("Second session."), sessionKey: sibling });
    expect(h.narration.frames.slice(-2).map(({ payload }) => payload.text)).toEqual([
      "First session.",
      "Second session.",
    ]);
    h.broadcast("chat", chat("Last partial."));
    h.broadcast("chat", {
      sessionKey: key,
      runId: "run",
      state: "error",
      errorMessage: "Stopped.",
    });
    expect(h.narration.frames.slice(-2).map(({ event }) => event)).toEqual([
      "session.narration",
      "chat",
    ]);
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
    expect(h.narration.frames.slice(-2).map(({ payload }) => payload.text)).toEqual([
      "Literal pending.",
      "Ops pending.",
    ]);
    expect(h.narration.frames).toHaveLength(6);

    publish("global", "main", "Raw resumed.");
    vi.advanceTimersByTime(100);
    publish("global", "main", "Raw retired.");
    publish(mainKey, "main", "Literal retired.");
    publish("global", "ops", "Ops retained.");
    h.subscribers.unsubscribe("narration", mainKey, "raw");
    h.subscribers.unsubscribe("narration", mainKey, "literal");
    vi.advanceTimersByTime(1_900);
    expect(h.narration.frames).toHaveLength(8);
    expect(h.narration.frames.at(-1)?.payload.text).toBe("Ops retained.");

    publish("global", "ops", "Retired on foreground admission.");
    h.subscribers.subscribe("narration", opsKey, { subscriptionId: "ops" });
    vi.advanceTimersByTime(2_000);
    expect(h.narration.frames).toHaveLength(8);
    publish("global", "ops", "Full transcript.");
    expect(h.narration.frames.at(-1)?.event).toBe("chat");
  });
});
