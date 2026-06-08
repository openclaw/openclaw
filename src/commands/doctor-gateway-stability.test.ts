import { describe, expect, it } from "vitest";
import type { DiagnosticStabilitySnapshot } from "../logging/diagnostic-stability.js";
import {
  buildGatewayChannelTurnHealthDoctorNote,
  buildGatewayQueueHealthDoctorNote,
  buildGatewayRuntimeRecommendationsDoctorNote,
  buildGatewaySessionAttentionDoctorNote,
} from "./doctor-gateway-stability.js";

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

function makeSnapshotFromSummary(
  summary: DiagnosticStabilitySnapshot["summary"],
): DiagnosticStabilitySnapshot {
  return {
    generatedAt: "2026-06-03T10:00:00.000Z",
    capacity: 1000,
    count: 1,
    dropped: 0,
    events: [],
    summary,
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
          startToDeliveryMs: {
            count: 1,
            slowCount: 0,
            latestMs: 2_500,
            maxMs: 2_500,
            p95Ms: 2_500,
          },
          bottleneck: {
            phase: "visible_delivery",
            metric: "startToDeliveryMs",
            maxMs: 2_500,
            slowCount: 0,
            count: 1,
          },
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
    expect(note?.body).toContain(
      "Latency bottleneck: phase=visible_delivery, metric=startToDeliveryMs, max=2500ms, slow=0/1.",
    );
    expect(note?.body).toContain("turn=turn-1");
    expect(note?.body).not.toContain("msg-1");
    expect(note?.body).not.toContain("Direct channel turn completed without visible delivery.");
  });

  it("reports channel turn tool failures without payload contents", () => {
    const note = buildGatewayChannelTurnHealthDoctorNote({
      snapshot: makeSnapshot({
        totalEvents: 4,
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
        tools: {
          called: 2,
          results: 1,
          failedResults: 1,
          missingResults: 1,
          slowResults: 0,
          preDeliveryCalls: 1,
          slowPreDeliveryResults: 0,
          byTool: {
            exec: {
              called: 1,
              results: 1,
              failedResults: 1,
              missingResults: 0,
              slowResults: 0,
              preDeliveryCalls: 1,
              slowPreDeliveryResults: 0,
              maxDurationMs: 500,
            },
            calendar: {
              called: 1,
              results: 0,
              failedResults: 0,
              missingResults: 1,
              slowResults: 0,
              preDeliveryCalls: 0,
              slowPreDeliveryResults: 0,
            },
          },
          recentSlow: [],
          recentFailures: [],
          recentPreDeliverySlow: [],
        },
        health: {
          status: "warning",
          issues: [
            {
              code: "tool_result_failed",
              level: "warning",
              count: 1,
              message: "A channel turn tool returned a failed result.",
              guidance: "Inspect the failed tool before retrying the whole turn.",
            },
            {
              code: "tool_result_missing",
              level: "warning",
              count: 1,
              message: "A channel turn completed with a started tool that had no recorded result.",
              guidance: "Check whether the run aborted or timed out.",
            },
          ],
        },
      }),
    });

    expect(note?.body).toContain(
      "Tools: called=2, results=1, failed=1, missing=1, slow=0, preDelivery=1, slowPreDelivery=0.",
    );
    expect(note?.body).toContain("exec(failed=1, missing=0, preDelivery=1, max=500ms)");
    expect(note?.body).toContain("calendar(failed=0, missing=1, preDelivery=0, max=unknown)");
    expect(note?.body).not.toContain("payload");
  });

  it("reports slow pre-delivery tool work", () => {
    const note = buildGatewayChannelTurnHealthDoctorNote({
      snapshot: makeSnapshot({
        totalEvents: 4,
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
        tools: {
          called: 1,
          results: 1,
          failedResults: 0,
          missingResults: 0,
          slowResults: 1,
          preDeliveryCalls: 1,
          slowPreDeliveryResults: 1,
          byTool: {
            home_assistant: {
              called: 1,
              results: 1,
              failedResults: 0,
              missingResults: 0,
              slowResults: 1,
              preDeliveryCalls: 1,
              slowPreDeliveryResults: 1,
              maxDurationMs: 18_000,
            },
          },
          recentSlow: [],
          recentFailures: [],
          recentPreDeliverySlow: [
            {
              seq: 12,
              ts: 1_717_421_000_000,
              channel: "telegram",
              turnId: "turn-ha",
              toolName: "home_assistant",
              durationMs: 18_000,
            },
          ],
        },
        health: {
          status: "warning",
          issues: [
            {
              code: "slow_tool_before_visible_delivery",
              level: "warning",
              count: 1,
              message: "A direct channel turn ran slow tool work before visible delivery.",
              guidance: "Send a short visible acknowledgement before long tools.",
            },
          ],
        },
      }),
    });

    expect(note?.body).toContain("slow_tool_before_visible_delivery");
    expect(note?.body).toContain("Recent slow pre-delivery tools:");
    expect(note?.body).toContain(
      "- seq=12 channel=telegram tool=home_assistant duration=18000ms turn=turn-ha",
    );
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
          receivedToTurnStartMs: {
            count: 1,
            slowCount: 1,
            latestMs: 15_000,
            maxMs: 15_000,
            p95Ms: 15_000,
          },
          bottleneck: {
            phase: "queue",
            metric: "receivedToTurnStartMs",
            maxMs: 15_000,
            slowCount: 1,
            count: 1,
          },
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
              count: 1,
              guidance:
                "Keep direct DM ingress and turn creation clear of background work; inspect queue pressure and timeout sources.",
            },
          ],
        },
      }),
    });

    expect(note?.body).toContain("slow_receive_to_turn_start");
    expect(note?.body).toContain("receivedToTurnStartMs=15000ms");
    expect(note?.body).toContain("count=1");
    expect(note?.body).toContain(
      "Latency: receivedToStart latest=15000ms max=15000ms p95=15000ms slow=1/1.",
    );
    expect(note?.body).toContain(
      "Latency bottleneck: phase=queue, metric=receivedToTurnStartMs, max=15000ms, slow=1/1.",
    );
    expect(note?.body).toContain("Recent slow turns:");
    expect(note?.body).toContain(
      "- seq=9 channel=telegram receivedToTurnStartMs=15000ms turn=turn-2",
    );
  });

  it("stays quiet when no session attention is present", () => {
    const note = buildGatewaySessionAttentionDoctorNote({
      snapshot: makeSnapshotFromSummary({ byType: {} }),
    });

    expect(note).toBeNull();
  });

  it("reports session attention without payload contents", () => {
    const note = buildGatewaySessionAttentionDoctorNote({
      sourceLabel: "live Gateway diagnostics",
      snapshot: makeSnapshotFromSummary({
        byType: { "session.stalled": 1 },
        sessions: {
          attention: {
            longRunning: 0,
            stalled: 1,
            stuck: 0,
            recoveryRequested: 1,
            recoveryCompleted: 0,
            byClassification: {
              blocked_tool_call: 1,
              active_work_without_progress: 1,
            },
            byActiveWorkKind: {
              tool_call: 1,
            },
            recent: [
              {
                seq: 12,
                ts: 1_717_421_000_000,
                type: "session.stalled",
                state: "processing",
                reason: "blocked_tool_call",
                classification: "blocked_tool_call",
                activeWorkKind: "tool_call",
                toolName: "home_assistant",
                ageMs: 90_000,
                queueDepth: 2,
              },
              {
                seq: 13,
                ts: 1_717_421_001_000,
                type: "session.recovery.requested",
                state: "processing",
                reason: "active_work_without_progress",
                activeWorkKind: "tool_call",
                ageMs: 91_000,
                queueDepth: 2,
              },
            ],
          },
        },
      }),
    });

    expect(note).toEqual({
      title: "Gateway sessions",
      body: expect.stringContaining("Session attention is active from live Gateway diagnostics."),
    });
    expect(note?.body).toContain(
      "Counts: longRunning=0, stalled=1, stuck=0, recoveryRequested=1, recoveryCompleted=0.",
    );
    expect(note?.body).toContain(
      "Classifications: active_work_without_progress=1, blocked_tool_call=1.",
    );
    expect(note?.body).toContain("Active work: tool_call=1.");
    expect(note?.body).toContain(
      "- seq=13 session.recovery.requested reason=active_work_without_progress activeWork=tool_call age=91000ms queueDepth=2",
    );
    expect(note?.body).toContain(
      "- seq=12 session.stalled classification=blocked_tool_call reason=blocked_tool_call activeWork=tool_call tool=home_assistant age=90000ms queueDepth=2",
    );
    expect(note?.body).toContain("official cancel, recovery, or TaskFlow handoff paths");
    expect(note?.body).not.toContain("payload");
    expect(note?.body).not.toContain("call-secret");
  });

  it("stays quiet for healthy queue lanes", () => {
    const note = buildGatewayQueueHealthDoctorNote({
      snapshot: makeSnapshotFromSummary({
        byType: { "queue.lane.dequeue": 1 },
        queues: {
          enqueued: 1,
          dequeued: 1,
          slowDequeues: 0,
          maxWaitMs: 250,
          maxQueueSize: 1,
          byLane: {
            main: {
              enqueued: 1,
              dequeued: 1,
              slowDequeues: 0,
              maxWaitMs: 250,
              maxQueueSize: 1,
            },
          },
          recentSlow: [],
        },
      }),
    });

    expect(note).toBeNull();
  });

  it("reports slow queue waits without raw session lanes", () => {
    const note = buildGatewayQueueHealthDoctorNote({
      sourceLabel: "live Gateway diagnostics",
      snapshot: makeSnapshotFromSummary({
        byType: { "queue.lane.dequeue": 2 },
        queues: {
          enqueued: 2,
          dequeued: 2,
          slowDequeues: 1,
          maxWaitMs: 12_500,
          maxQueueSize: 3,
          byLane: {
            session: {
              enqueued: 1,
              dequeued: 1,
              slowDequeues: 1,
              maxWaitMs: 12_500,
              maxQueueSize: 3,
            },
            main: {
              enqueued: 1,
              dequeued: 1,
              slowDequeues: 0,
              maxWaitMs: 250,
              maxQueueSize: 1,
            },
          },
          recentSlow: [
            {
              seq: 8,
              ts: 1_717_421_000_000,
              lane: "session",
              waitMs: 12_500,
              queueSize: 2,
            },
          ],
        },
      }),
    });

    expect(note).toEqual({
      title: "Gateway queues",
      body: expect.stringContaining("Queue health needs attention from live Gateway diagnostics."),
    });
    expect(note?.body).toContain(
      "Counts: enqueued=2, dequeued=2, slow=1, maxWait=12500ms, maxQueue=3.",
    );
    expect(note?.body).toContain("session(enq=1, deq=1, slow=1, maxWait=12500ms, maxQueue=3)");
    expect(note?.body).toContain("main(enq=1, deq=1, slow=0, maxWait=250ms, maxQueue=1)");
    expect(note?.body).toContain("Recent slow queue waits:");
    expect(note?.body).toContain("- seq=8 lane=session wait=12500ms queueSize=2");
    expect(note?.body).toContain(
      "direct-control lanes should not wait behind long tool or cron work",
    );
    expect(note?.body).not.toContain("telegram:direct:owner");
  });

  it("stays quiet when no runtime recommendations are present", () => {
    const note = buildGatewayRuntimeRecommendationsDoctorNote({
      snapshot: makeSnapshotFromSummary({ byType: {} }),
    });

    expect(note).toBeNull();
  });

  it("reports runtime recommendations without raw private context", () => {
    const note = buildGatewayRuntimeRecommendationsDoctorNote({
      sourceLabel: "live Gateway diagnostics",
      snapshot: makeSnapshotFromSummary({
        byType: { "channel.turn.event": 1 },
        recommendations: [
          {
            code: "inspect_missing_delivery",
            priority: "high",
            source: "channel_turns",
            reason: "missing_visible_delivery",
            count: 1,
            guidance:
              "Inspect the visible channel dispatch path; direct DMs must record delivery.sent before the turn is considered healthy.",
          },
          {
            code: "clear_queue_pressure",
            priority: "medium",
            source: "queues",
            reason: "slow_queue_dequeue",
            metric: "waitMs",
            valueMs: 12_500,
            count: 1,
            guidance:
              "Inspect queue/session pressure, stale work, and overlapping background jobs; direct control messages should not wait behind long work.",
          },
        ],
      }),
    });

    expect(note).toEqual({
      title: "Gateway runtime recommendations",
      body: expect.stringContaining("Runtime recommendations from live Gateway diagnostics:"),
    });
    expect(note?.body).toContain(
      "- high: inspect_missing_delivery source=channel_turns reason=missing_visible_delivery count=1",
    );
    expect(note?.body).toContain(
      "- medium: clear_queue_pressure source=queues reason=slow_queue_dequeue metric=waitMs value=12500ms count=1",
    );
    expect(note?.body).toContain("Guidance: Inspect queue/session pressure");
    expect(note?.body).not.toContain("telegram:direct:owner");
    expect(note?.body).not.toContain("private message");
  });
});
