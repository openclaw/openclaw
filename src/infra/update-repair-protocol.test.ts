import { describe, expect, it } from "vitest";
import { updateRepairParentMessageSchema } from "./update-repair-protocol.js";

// The released post-activation launcher omits authority and context.phase.
const releasedStart = {
  type: "start",
  runId: "released-update-run",
  requester: { channel: "synthetic", senderId: "owner" },
  target: {
    stateDir: "/synthetic/live-state",
    configPath: "/synthetic/live-state/openclaw.json",
    workspaceDir: "/synthetic/workspace",
    installRoot: "/synthetic/install",
  },
  failure: { error: "Candidate verification failed" },
  context: { beforeVersion: "2026.9.4", targetVersion: "2026.9.5" },
  budget: { maxTurns: 1, wallClockMs: 10_000 },
};
const authority = {
  stateDir: releasedStart.target.stateDir,
  configPath: releasedStart.target.configPath,
  workspaceDir: releasedStart.target.workspaceDir,
};

describe("update repair parent protocol", () => {
  it("normalizes the released post-activation start to live target authority", () => {
    expect(updateRepairParentMessageSchema.parse(releasedStart)).toMatchObject({
      ...releasedStart,
      authority,
      context: { ...releasedStart.context, phase: "verifying" },
    });
  });

  it.each(["validating", "verifying"])(
    "rejects an explicit %s phase without live authority",
    (phase) => {
      expect(
        updateRepairParentMessageSchema.safeParse({
          ...releasedStart,
          context: { ...releasedStart.context, phase },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects authority-bearing starts without an explicit phase", () => {
    expect(updateRepairParentMessageSchema.safeParse({ ...releasedStart, authority }).success).toBe(
      false,
    );
  });

  it("preserves separate live authority for a modern rehearsal", () => {
    const start = {
      ...releasedStart,
      authority,
      target: { ...releasedStart.target, stateDir: "/synthetic/rehearsal" },
      context: { ...releasedStart.context, phase: "validating" },
    };
    expect(updateRepairParentMessageSchema.parse(start)).toMatchObject(start);
  });
});
