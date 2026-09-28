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
describe("update repair parent protocol", () => {
  it("accepts the released post-activation start without a phase", () => {
    expect(updateRepairParentMessageSchema.parse(releasedStart)).toMatchObject(releasedStart);
  });

  it.each(["validating", "verifying"])("preserves the explicit %s phase", (phase) => {
    const start = { ...releasedStart, context: { ...releasedStart.context, phase } };
    expect(updateRepairParentMessageSchema.parse(start)).toMatchObject(start);
  });

  it.each(["repairing", "", null])("rejects an invalid phase %s", (phase) => {
    expect(
      updateRepairParentMessageSchema.safeParse({
        ...releasedStart,
        context: { ...releasedStart.context, phase },
      }).success,
    ).toBe(false);
  });

  it("preserves copied-state selectors without accepting admission environment on the wire", () => {
    const start = {
      ...releasedStart,
      target: {
        ...releasedStart.target,
        stateDir: "/synthetic/rehearsal",
        environment: { HOME: "/synthetic/rehearsal-home" },
      },
      context: { ...releasedStart.context, phase: "validating" },
    };
    expect(updateRepairParentMessageSchema.parse(start)).toMatchObject(start);
    expect(
      updateRepairParentMessageSchema.parse({
        ...start,
        admissionEnv: { HOME: "/synthetic/untrusted-home" },
      }),
    ).not.toHaveProperty("admissionEnv");
  });
});
