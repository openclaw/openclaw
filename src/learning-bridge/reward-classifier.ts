import type { ResearchEventV1, RewardSignal } from "../research/events/types.js";

function rewardForEvent(event: ResearchEventV1): RewardSignal | undefined {
  switch (event.kind) {
    case "approval.allow":
      return {
        kind: "binary",
        source: "approval_decision",
        confidence: 1,
        scalar: 1,
      };
    case "approval.deny":
      return {
        kind: "binary",
        source: "approval_decision",
        confidence: 1,
        scalar: -1,
      };
    case "tool.end": {
      if (event.payload.ok) {
        return undefined;
      }
      return {
        kind: "binary",
        source: "env_outcome",
        confidence: 0.9,
        scalar: -0.7,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Deterministic, narrow v1 rules: approval allow/deny, failed tool.end.
 * Returns a shallow copy of each event with `reward` set when a rule matches.
 */
export function classifyResearchEvents(events: ResearchEventV1[]): ResearchEventV1[] {
  return events.map((event) => {
    const reward = rewardForEvent(event);
    if (!reward) {
      return event;
    }
    return { ...event, reward };
  });
}
