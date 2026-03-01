import { describe, expect, it } from "vitest";
import { detectSymptoms } from "./symptom-detector.js";
import type { QueueTimeline, SimInboundMessage, SimMessage, SimOutboundMessage } from "./types.js";

function makeInbound(convId: string, id: string, ts: number, seq: number): SimInboundMessage {
  return { id, ts, seq, direction: "inbound", conversationId: convId, text: "hi", senderId: "u1" };
}

function makeOutbound(
  convId: string,
  id: string,
  ts: number,
  seq: number,
  parentId: string,
  parentTs: number,
  waitMs?: number,
): SimOutboundMessage {
  return {
    id,
    ts,
    seq,
    direction: "outbound",
    conversationId: convId,
    text: "reply",
    agentId: "a1",
    causalParentId: parentId,
    causalParentTs: parentTs,
    queueWaitMs: waitMs,
  };
}

const emptyTimeline: QueueTimeline = { snapshots: [], events: [] };

describe("detectSymptoms", () => {
  describe("reply explosion", () => {
    it("detects when outbound/inbound ratio exceeds threshold", () => {
      const messages: SimMessage[] = [
        makeInbound("c1", "in-1", 1000, 0),
        makeOutbound("c1", "out-1", 2000, 1, "in-1", 1000),
        makeOutbound("c1", "out-2", 3000, 2, "in-1", 1000),
        makeOutbound("c1", "out-3", 4000, 3, "in-1", 1000),
      ];
      const symptoms = detectSymptoms({
        messages,
        timeline: emptyTimeline,
        thresholds: { reply_explosion: { maxRatio: 1.5, windowMs: 10000 } },
      });
      expect(symptoms.some((s) => s.type === "reply_explosion")).toBe(true);
    });

    it("does not trigger when ratio is acceptable", () => {
      const messages: SimMessage[] = [
        makeInbound("c1", "in-1", 1000, 0),
        makeOutbound("c1", "out-1", 2000, 1, "in-1", 1000),
      ];
      const symptoms = detectSymptoms({
        messages,
        timeline: emptyTimeline,
        thresholds: { reply_explosion: { maxRatio: 1.5, windowMs: 10000 } },
      });
      expect(symptoms.some((s) => s.type === "reply_explosion")).toBe(false);
    });
  });

  describe("stale context", () => {
    it("detects when agent missed messages", () => {
      const messages: SimMessage[] = [
        makeInbound("c1", "in-1", 1000, 0),
        makeInbound("c1", "in-2", 2000, 1),
        makeInbound("c1", "in-3", 3000, 2),
        makeInbound("c1", "in-4", 4000, 3),
        // Agent replies based on in-1, missing in-2, in-3, in-4
        makeOutbound("c1", "out-1", 5000, 4, "in-1", 1000),
      ];
      const symptoms = detectSymptoms({
        messages,
        timeline: emptyTimeline,
        thresholds: { stale_context: { maxStaleness: 2 } },
      });
      expect(symptoms.some((s) => s.type === "stale_context")).toBe(true);
    });
  });

  describe("queue backlog", () => {
    it("detects when queue depth exceeds threshold", () => {
      const timeline: QueueTimeline = {
        snapshots: [{ ts: 1000, lane: "main", queued: 25, active: 1, maxConcurrent: 1 }],
        events: [],
      };
      const symptoms = detectSymptoms({
        messages: [],
        timeline,
        thresholds: { queue_backlog: { maxDepth: 20, sustainedGrowthSamples: 1 } },
      });
      expect(symptoms.some((s) => s.type === "queue_backlog")).toBe(true);
    });
  });

  describe("out of sync", () => {
    it("detects when two agents share the same causal parent", () => {
      const messages: SimMessage[] = [
        makeInbound("c1", "in-1", 1000, 0),
        makeOutbound("c1", "out-1", 2000, 1, "in-1", 1000),
        makeOutbound("c1", "out-2", 2500, 2, "in-1", 1000),
      ];
      const symptoms = detectSymptoms({
        messages,
        timeline: emptyTimeline,
        thresholds: { out_of_sync: { enabled: true } },
      });
      expect(symptoms.some((s) => s.type === "out_of_sync")).toBe(true);
    });
  });
});
