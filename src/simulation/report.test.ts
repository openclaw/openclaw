import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import type { SimInboundMessage, SimOutboundMessage } from "./types.js";

describe("buildReport", () => {
  it("builds a report with correct summary", () => {
    const messages = [
      {
        id: "in-1",
        ts: 1000,
        seq: 0,
        direction: "inbound" as const,
        conversationId: "c1",
        text: "hello",
        senderId: "u1",
      } satisfies SimInboundMessage,
      {
        id: "out-1",
        ts: 2000,
        seq: 1,
        direction: "outbound" as const,
        conversationId: "c1",
        text: "reply",
        agentId: "a1",
        causalParentId: "in-1",
        causalParentTs: 1000,
        queueWaitMs: 50,
      } satisfies SimOutboundMessage,
    ];

    const report = buildReport({
      scenarioName: "test",
      seed: 42,
      startedAt: new Date("2026-01-01T00:00:00Z"),
      messages,
      timeline: { snapshots: [], events: [] },
      symptoms: [],
    });

    expect(report.scenario).toBe("test");
    expect(report.seed).toBe(42);
    expect(report.summary.totalMessages).toBe(2);
    expect(report.summary.inbound).toBe(1);
    expect(report.summary.outbound).toBe(1);
    expect(report.summary.conversations).toBe(1);
    expect(report.summary.waitTimeP50).toBe(50);
  });

  it("evaluates assertions", () => {
    const report = buildReport({
      scenarioName: "test",
      startedAt: new Date(),
      messages: [
        {
          id: "in-1",
          ts: 1000,
          seq: 0,
          direction: "inbound",
          conversationId: "c1",
          text: "hello",
          senderId: "u1",
        } satisfies SimInboundMessage,
        {
          id: "out-1",
          ts: 2000,
          seq: 1,
          direction: "outbound",
          conversationId: "c1",
          text: "reply",
          agentId: "a1",
          causalParentId: "in-1",
          causalParentTs: 1000,
        } satisfies SimOutboundMessage,
      ],
      timeline: { snapshots: [], events: [] },
      symptoms: [],
      assertions: [{ type: "no_reply_explosion", maxRepliesPerMessage: 2 }],
    });

    expect(report.assertions).toHaveLength(1);
    expect(report.assertions[0].passed).toBe(true);
    expect(report.assertions[0].name).toBe("no_reply_explosion");
  });
});
