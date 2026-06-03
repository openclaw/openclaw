import { describe, expect, it } from "vitest";
import type { DiagnosticStabilitySnapshot } from "../logging/diagnostic-stability.js";
import { buildGatewayChannelTurnHealthDoctorNote } from "./doctor-gateway-stability.js";

function makeSnapshot(
  channelTurns: NonNullable<DiagnosticStabilitySnapshot["summary"]["channelTurns"]>,
): DiagnosticStabilitySnapshot {
  return {
    generatedAt: "2026-06-03T10:00:00.000Z",
    capacity: 1000,
    count: channelTurns.totalEvents,
    dropped: 0,
    events: [],
    summary: {
      byType: {},
      channelTurns,
    },
  };
}

describe("doctor gateway stability", () => {
  it("stays quiet when channel turn health is ok", () => {
    const note = buildGatewayChannelTurnHealthDoctorNote({
      snapshot: makeSnapshot({
        totalEvents: 2,
        deliveryRequired: 1,
        deliverySent: 1,
        deliveryFailed: 0,
        invalidCompletions: 0,
        missingVisibleDelivery: 0,
        byChannel: {
          telegram: {
            deliveryRequired: 1,
            deliverySent: 1,
            deliveryFailed: 0,
            invalidCompletions: 0,
            missingVisibleDelivery: 0,
          },
        },
        recentFailures: [],
        health: { status: "ok", issues: [] },
      }),
    });

    expect(note).toBeNull();
  });

  it("reports missing visible delivery without message contents", () => {
    const note = buildGatewayChannelTurnHealthDoctorNote({
      sourceLabel: "live Gateway diagnostics",
      snapshot: makeSnapshot({
        totalEvents: 4,
        deliveryRequired: 1,
        deliverySent: 0,
        deliveryFailed: 1,
        invalidCompletions: 1,
        missingVisibleDelivery: 1,
        byChannel: {
          telegram: {
            deliveryRequired: 1,
            deliverySent: 0,
            deliveryFailed: 1,
            invalidCompletions: 1,
            missingVisibleDelivery: 1,
          },
        },
        recentFailures: [
          {
            seq: 7,
            ts: 1_717_421_000_000,
            channel: "telegram",
            turnId: "turn-1",
            messageId: "msg-1",
            reason: "missing_visible_delivery",
          },
        ],
        latency: {
          startToDeliveryMs: { count: 1, slowCount: 0, latestMs: 2_500, maxMs: 2_500 },
          recentSlow: [],
        },
        health: {
          status: "degraded",
          issues: [
            {
              code: "missing_visible_delivery",
              level: "degraded",
              count: 1,
              message: "Direct channel turn completed without visible delivery.",
              guidance:
                "Treat direct DM delivery as unhealthy; inspect message(action=send) dispatch before declaring the turn complete.",
            },
          ],
        },
      }),
    });

    expect(note).toEqual({
      title: "Gateway channel turns",
      body: expect.stringContaining("Channel turn health is degraded"),
    });
    expect(note?.body).toContain("missing_visible_delivery");
    expect(note?.body).toContain("turn=turn-1");
    expect(note?.body).not.toContain("msg-1");
    expect(note?.body).not.toContain("Direct channel turn completed without visible delivery.");
  });

  it("reports slow direct-message latency as a doctor health issue", () => {
    const note = buildGatewayChannelTurnHealthDoctorNote({
      snapshot: makeSnapshot({
        totalEvents: 3,
        deliveryRequired: 1,
        deliverySent: 1,
        deliveryFailed: 0,
        invalidCompletions: 0,
        missingVisibleDelivery: 0,
        byChannel: {
          telegram: {
            deliveryRequired: 1,
            deliverySent: 1,
            deliveryFailed: 0,
            invalidCompletions: 0,
            missingVisibleDelivery: 0,
          },
        },
        recentFailures: [],
        latency: {
          receivedToTurnStartMs: { count: 1, slowCount: 1, latestMs: 15_000, maxMs: 15_000 },
          recentSlow: [
            {
              seq: 9,
              ts: 1_717_421_000_000,
              channel: "telegram",
              turnId: "turn-2",
              metric: "receivedToTurnStartMs",
              valueMs: 15_000,
            },
          ],
        },
        health: {
          status: "warning",
          issues: [
            {
              code: "slow_receive_to_turn_start",
              level: "warning",
              message: "Direct message ingress was slow.",
              metric: "receivedToTurnStartMs",
              valueMs: 15_000,
              guidance:
                "Keep direct DM ingress and turn creation clear of background work; inspect queue pressure and timeout sources.",
            },
          ],
        },
      }),
    });

    expect(note?.body).toContain("slow_receive_to_turn_start");
    expect(note?.body).toContain("receivedToTurnStartMs=15000ms");
    expect(note?.body).toContain("Latency: receivedToStart latest=15000ms max=15000ms slow=1/1.");
    expect(note?.body).toContain("Recent slow turns:");
    expect(note?.body).toContain(
      "- seq=9 channel=telegram receivedToTurnStartMs=15000ms turn=turn-2",
    );
  });
});
