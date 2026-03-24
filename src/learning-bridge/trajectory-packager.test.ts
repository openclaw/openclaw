import { describe, expect, it } from "vitest";
import type { ResearchEventV1 } from "../research/events/types.js";
import { classifyResearchEvents } from "./reward-classifier.js";
import { buildTrajectoryPackage } from "./trajectory-packager.js";

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

describe("buildTrajectoryPackage", () => {
  it("builds package with dominant binary when only tool failures present", () => {
    const raw = [
      baseEvent({ kind: "run.start", payload: {} }),
      baseEvent({
        kind: "tool.start",
        payload: { toolName: "exec", toolCallId: "c1" },
      }),
      baseEvent({
        kind: "tool.end",
        payload: { toolName: "exec", toolCallId: "c1", ok: false },
      }),
      baseEvent({ kind: "run.end", payload: {} }),
    ];
    const enriched = classifyResearchEvents(raw);
    const pkg = buildTrajectoryPackage({
      packageId: "pkg-1",
      agentId: "a1",
      runId: "r1",
      sessionId: "s1",
      createdAtMs: 1000,
      enrichedEvents: enriched,
    });
    expect(pkg.schemaVersion).toBe("trajectory.v2");
    expect(pkg.dominantSignalKind).toBe("binary");
    expect(pkg.suggestedRLMethod).toBe("binary");
    expect(pkg.skillsActivated).toEqual(["exec"]);
    expect(pkg.turns.length).toBe(2);
  });
});
