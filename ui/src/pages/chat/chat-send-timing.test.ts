// @vitest-environment node
import { expect, it } from "vitest";
import type { ChatSendTimingEntry } from "./chat-send-ack.ts";
import { registerChatSendTiming, updateChatSendAckTiming } from "./chat-send-timing.ts";

it("bounds send timing correlations through registration and late acknowledgment remapping", () => {
  const timings = new Map<string, ChatSendTimingEntry>();
  const host = {
    hello: null,
    sessionKey: "agent:main",
    chatQueue: [],
    chatSendTimingsByRun: timings,
  };
  const item = { sessionKey: host.sessionKey, sendAttempts: 1, sendSubmittedAtMs: 10 };
  for (let index = 0; index < 80; index += 1) {
    const runId = `run-${index}`;
    registerChatSendTiming(host, item, runId, 20);
    updateChatSendAckTiming(host, runId, { status: "ok", runId }, item, 20);
  }

  expect([...timings.keys()]).toEqual(
    Array.from({ length: 40 }, (_, index) => `run-${index + 40}`),
  );
  registerChatSendTiming(host, item, "run-80", 20);
  expect(timings.size).toBe(40);
  expect(timings.has("run-40")).toBe(false);
  updateChatSendAckTiming(host, "run-79", { status: "started", runId: "accepted-79" }, item, 20);
  expect(timings.has("run-79")).toBe(false);
  expect(timings.get("accepted-79")).toEqual({
    runId: "accepted-79",
    sessionKey: host.sessionKey,
    agentId: undefined,
    sendAttempts: 1,
    sendState: undefined,
    submittedAtMs: 10,
    ackStatus: "started",
  });

  updateChatSendAckTiming(host, "run-0", { status: "ok", runId: "late-accepted" }, item, 20);
  expect(timings.size).toBe(40);
  expect(timings.has("run-41")).toBe(false);
  expect(timings.get("late-accepted")).toMatchObject({
    runId: "late-accepted",
    submittedAtMs: 10,
    ackStatus: "ok",
  });
});
