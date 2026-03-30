import { beforeEach, describe, expect, test } from "vitest";
import {
  clearAgentRunContext,
  emitAgentEvent,
  getAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
  resetAgentEventsForTest,
  resetAgentRunContextForTest,
} from "./agent-events.js";

type AgentEventsModule = typeof import("./agent-events.js");

const agentEventsModuleUrl = new URL("./agent-events.ts", import.meta.url).href;

async function importAgentEventsModule(cacheBust: string): Promise<AgentEventsModule> {
  return (await import(`${agentEventsModuleUrl}?t=${cacheBust}`)) as AgentEventsModule;
}

describe("agent-events sequencing", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
  });

  test("stores and clears run context", async () => {
    registerAgentRunContext("run-1", { sessionKey: "main" });
    expect(getAgentRunContext("run-1")?.sessionKey).toBe("main");
    clearAgentRunContext("run-1");
    expect(getAgentRunContext("run-1")).toBeUndefined();
  });

  test("maintains monotonic seq per runId", async () => {
    const seen: Record<string, number[]> = {};
    const stop = onAgentEvent((evt) => {
      const list = seen[evt.runId] ?? [];
      seen[evt.runId] = list;
      list.push(evt.seq);
    });

    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-2", stream: "lifecycle", data: {} });
    emitAgentEvent({ runId: "run-1", stream: "lifecycle", data: {} });

    stop();

    expect(seen["run-1"]).toEqual([1, 2, 3]);
    expect(seen["run-2"]).toEqual([1]);
  });

  test("preserves compaction ordering on the event bus", async () => {
    const phases: Array<string> = [];
    const stop = onAgentEvent((evt) => {
      if (evt.runId !== "run-1") {
        return;
      }
      if (evt.stream !== "compaction") {
        return;
      }
      if (typeof evt.data?.phase === "string") {
        phases.push(evt.data.phase);
      }
    });

    emitAgentEvent({ runId: "run-1", stream: "compaction", data: { phase: "start" } });
    emitAgentEvent({
      runId: "run-1",
      stream: "compaction",
      data: { phase: "end", willRetry: false },
    });

    stop();

    expect(phases).toEqual(["start", "end"]);
  });

  test("omits sessionKey for runs hidden from Control UI", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-imessage",
      isControlUiVisible: false,
    });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-hidden",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "session-imessage",
    });
    stop();

    expect(receivedSessionKey).toBeUndefined();
  });

  test("merges later run context updates into existing runs", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-ctx", {
      sessionKey: "session-main",
      isControlUiVisible: true,
    });
    registerAgentRunContext("run-ctx", {
      verboseLevel: "full",
      isHeartbeat: true,
    });

    expect(getAgentRunContext("run-ctx")).toEqual({
      sessionKey: "session-main",
      verboseLevel: "full",
      isHeartbeat: true,
      isControlUiVisible: true,
    });
  });

  test("falls back to registered sessionKey when event sessionKey is blank", async () => {
    resetAgentRunContextForTest();
    registerAgentRunContext("run-ctx", { sessionKey: "session-main" });

    let receivedSessionKey: string | undefined;
    const stop = onAgentEvent((evt) => {
      receivedSessionKey = evt.sessionKey;
    });
    emitAgentEvent({
      runId: "run-ctx",
      stream: "assistant",
      data: { text: "hi" },
      sessionKey: "   ",
    });
    stop();

    expect(receivedSessionKey).toBe("session-main");
  });

  test("keeps notifying later listeners when one throws", async () => {
    const seen: string[] = [];
    const stopBad = onAgentEvent(() => {
      throw new Error("boom");
    });
    const stopGood = onAgentEvent((evt) => {
      seen.push(evt.runId);
    });

    expect(() =>
      emitAgentEvent({
        runId: "run-safe",
        stream: "assistant",
        data: { text: "hi" },
      }),
    ).not.toThrow();

    stopGood();
    stopBad();

    expect(seen).toEqual(["run-safe"]);
  });

  test("shares run context, listeners, and sequence state across duplicate module instances", async () => {
    const first = await importAgentEventsModule(`first-${Date.now()}`);
    const second = await importAgentEventsModule(`second-${Date.now()}`);

    first.resetAgentEventsForTest();
    first.registerAgentRunContext("run-dup", { sessionKey: "session-dup" });

    const seen: Array<{ seq: number; sessionKey?: string }> = [];
    const stop = first.onAgentEvent((evt) => {
      if (evt.runId === "run-dup") {
        seen.push({ seq: evt.seq, sessionKey: evt.sessionKey });
      }
    });

    second.emitAgentEvent({
      runId: "run-dup",
      stream: "assistant",
      data: { text: "from second" },
      sessionKey: "   ",
    });
    first.emitAgentEvent({
      runId: "run-dup",
      stream: "assistant",
      data: { text: "from first" },
      sessionKey: "   ",
    });

    stop();

    expect(second.getAgentRunContext("run-dup")).toEqual({ sessionKey: "session-dup" });
    expect(seen).toEqual([
      { seq: 1, sessionKey: "session-dup" },
      { seq: 2, sessionKey: "session-dup" },
    ]);

    first.resetAgentEventsForTest();
  });
});
