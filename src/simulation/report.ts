import type {
  QueueTimeline,
  SimAssertionConfig,
  SimAssertionResult,
  SimMessage,
  SimReport,
  SimSummary,
  SimSymptom,
} from "./types.js";

// ── Percentile calculation ───────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Summary builder ──────────────────────────────────────────────────

function buildSummary(messages: readonly SimMessage[], symptoms: SimSymptom[]): SimSummary {
  let inbound = 0;
  let outbound = 0;
  const conversations = new Set<string>();
  const waitTimes: number[] = [];

  for (const msg of messages) {
    conversations.add(msg.conversationId);
    if (msg.direction === "inbound") {
      inbound++;
    } else {
      outbound++;
      if (msg.queueWaitMs !== undefined) {
        waitTimes.push(msg.queueWaitMs);
      }
    }
  }

  waitTimes.sort((a, b) => a - b);

  const symptomCount = { critical: 0, warning: 0, info: 0 };
  for (const s of symptoms) {
    symptomCount[s.severity]++;
  }

  return {
    totalMessages: messages.length,
    inbound,
    outbound,
    conversations: conversations.size,
    symptomCount,
    waitTimeP50: waitTimes.length > 0 ? percentile(waitTimes, 50) : undefined,
    waitTimeP95: waitTimes.length > 0 ? percentile(waitTimes, 95) : undefined,
    waitTimeP99: waitTimes.length > 0 ? percentile(waitTimes, 99) : undefined,
  };
}

// ── Assertion evaluation ─────────────────────────────────────────────

function evaluateAssertions(
  assertions: SimAssertionConfig[],
  messages: readonly SimMessage[],
  timeline: QueueTimeline,
  symptoms: SimSymptom[],
): SimAssertionResult[] {
  const results: SimAssertionResult[] = [];

  for (const assertion of assertions) {
    switch (assertion.type) {
      case "max_queue_depth": {
        let maxDepth = 0;
        for (const snap of timeline.snapshots) {
          if (assertion.lane !== "*" && !snap.lane.includes(assertion.lane.replace("*", ""))) {
            continue;
          }
          maxDepth = Math.max(maxDepth, snap.queued + snap.active);
        }
        results.push({
          name: `max_queue_depth(${assertion.lane})`,
          passed: maxDepth <= assertion.threshold,
          actual: maxDepth,
          threshold: assertion.threshold,
        });
        break;
      }
      case "max_reply_latency_ms": {
        let maxLatency = 0;
        for (const msg of messages) {
          if (msg.direction === "outbound" && msg.runDurationMs !== undefined) {
            maxLatency = Math.max(maxLatency, msg.runDurationMs + (msg.queueWaitMs ?? 0));
          }
        }
        results.push({
          name: "max_reply_latency_ms",
          passed: maxLatency <= assertion.threshold,
          actual: maxLatency,
          threshold: assertion.threshold,
        });
        break;
      }
      case "no_reply_explosion": {
        const byConv = new Map<string, { inbound: number; outbound: number }>();
        for (const msg of messages) {
          let c = byConv.get(msg.conversationId);
          if (!c) {
            c = { inbound: 0, outbound: 0 };
            byConv.set(msg.conversationId, c);
          }
          if (msg.direction === "inbound") {
            c.inbound++;
          } else {
            c.outbound++;
          }
        }
        let worstRatio = 0;
        for (const c of byConv.values()) {
          if (c.inbound > 0) {
            worstRatio = Math.max(worstRatio, c.outbound / c.inbound);
          }
        }
        results.push({
          name: "no_reply_explosion",
          passed: worstRatio <= assertion.maxRepliesPerMessage,
          actual: worstRatio,
          threshold: assertion.maxRepliesPerMessage,
        });
        break;
      }
      case "no_stale_context": {
        const staleSymptoms = symptoms.filter((s) => s.type === "stale_context");
        const maxStaleness = staleSymptoms.reduce(
          (max, s) => (s.type === "stale_context" ? Math.max(max, s.staleness) : max),
          0,
        );
        results.push({
          name: "no_stale_context",
          passed: maxStaleness <= assertion.maxStaleness,
          actual: maxStaleness,
          threshold: assertion.maxStaleness,
        });
        break;
      }
      case "no_symptoms": {
        const minSeverity = assertion.severity ?? "warning";
        const matching = symptoms.filter(
          (s) =>
            s.severity === minSeverity || (minSeverity === "warning" && s.severity === "critical"),
        );
        results.push({
          name: `no_symptoms(${minSeverity}+)`,
          passed: matching.length === 0,
          actual: matching.length,
          threshold: 0,
        });
        break;
      }
    }
  }

  return results;
}

// ── Report builder ───────────────────────────────────────────────────

export function buildReport(params: {
  scenarioName: string;
  seed?: number;
  startedAt: Date;
  messages: readonly SimMessage[];
  timeline: QueueTimeline;
  symptoms: SimSymptom[];
  assertions?: SimAssertionConfig[];
}): SimReport {
  const durationMs = Date.now() - params.startedAt.getTime();
  const assertionResults = params.assertions
    ? evaluateAssertions(params.assertions, params.messages, params.timeline, params.symptoms)
    : [];

  return {
    scenario: params.scenarioName,
    seed: params.seed,
    startedAt: params.startedAt.toISOString(),
    durationMs,
    summary: buildSummary(params.messages, params.symptoms),
    messages: [...params.messages],
    timeline: params.timeline,
    symptoms: params.symptoms,
    assertions: assertionResults,
  };
}
