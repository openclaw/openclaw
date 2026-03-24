import { describe, expect, it } from "vitest";
import type { ResearchEventV1 } from "../research/events/types.js";
import { classifyResearchEvents } from "./reward-classifier.js";

function baseEvent(
  partial: Omit<ResearchEventV1, "v" | "ts" | "runId" | "sessionId" | "agentId"> &
    Pick<ResearchEventV1, "kind" | "payload">,
): ResearchEventV1 {
  return {
    v: 1,
    ts: 1,
    runId: "r1",
    sessionId: "s1",
    agentId: "a1",
    ...partial,
  } as ResearchEventV1;
}

describe("classifyResearchEvents", () => {
  it("tags approval.allow with positive binary reward", () => {
    const events = [
      baseEvent({
        kind: "approval.allow",
        payload: { approvalId: "ap1" },
      }),
    ];
    const out = classifyResearchEvents(events);
    expect(out[0]?.reward?.scalar).toBe(1);
    expect(out[0]?.reward?.source).toBe("approval_decision");
  });

  it("tags approval.deny with negative binary reward", () => {
    const events = [
      baseEvent({
        kind: "approval.deny",
        payload: { approvalId: "ap1" },
      }),
    ];
    const out = classifyResearchEvents(events);
    expect(out[0]?.reward?.scalar).toBe(-1);
  });

  it("tags failed tool.end with negative partial reward", () => {
    const events = [
      baseEvent({
        kind: "tool.end",
        payload: {
          toolName: "exec",
          toolCallId: "c1",
          ok: false,
        },
      }),
    ];
    const out = classifyResearchEvents(events);
    expect(out[0]?.reward?.scalar).toBe(-0.7);
    expect(out[0]?.reward?.source).toBe("env_outcome");
  });

  it("leaves successful tool.end without reward", () => {
    const events = [
      baseEvent({
        kind: "tool.end",
        payload: {
          toolName: "exec",
          toolCallId: "c1",
          ok: true,
        },
      }),
    ];
    const out = classifyResearchEvents(events);
    expect(out[0]?.reward).toBeUndefined();
  });
});
