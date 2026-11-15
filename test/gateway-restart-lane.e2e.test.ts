import { expect, it } from "vitest";
import { measureRestartLaneFlood } from "./gateway-restart-lane.test-support.js";

it(
  "keeps forty restart resumptions out of scheduled cron capacity",
  { timeout: 180_000 },
  async ({ signal }) => {
    const proof = await measureRestartLaneFlood({ signal });
    expect(
      proof.lanesAtRecoveryAdmission.find((lane) => lane.lane === "restart-recovery"),
    ).toMatchObject({ activeCount: 8, queuedCount: 32 });
    expect(
      proof.lanesAtRecoveryAdmission.find((lane) => lane.lane === "cron-nested"),
    ).toMatchObject({ activeCount: 0, queuedCount: 0 });
    expect(proof.newCronRequestToModelMs.samples).toBe(12);
    expect(proof.resumeDispatchFromFirstMs.samples).toBe(40);
    const firstCron = proof.calls.findIndex((call) => call.kind === "cron");
    expect(firstCron).toBeGreaterThanOrEqual(0);
    expect(
      proof.calls.slice(0, firstCron).filter((call) => call.kind === "resume").length,
    ).toBeLessThan(40);
  },
);
