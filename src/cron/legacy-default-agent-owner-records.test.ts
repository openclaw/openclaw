import { describe, expect, it } from "vitest";
import { materializeLegacyDefaultCronJobOwnersInRecords } from "./legacy-default-agent-owner-records.js";
import { getInvalidPersistedCronJobReason } from "./persisted-shape.js";
import { assertCronStoreCanPersist } from "./store/row-codec.js";

function persistedJob(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

describe("legacy default cron record ownership", () => {
  it("backfills only an absent agentId and preserves malformed explicit values", () => {
    const numericOwner = { ...persistedJob("numeric"), agentId: 123 };
    const blankOwner = { ...persistedJob("blank"), agentId: "" };
    const absentOwner = persistedJob("absent");
    const records = [numericOwner, blankOwner, absentOwner];

    expect(materializeLegacyDefaultCronJobOwnersInRecords(records, "ops")).toBe(1);
    expect(numericOwner.agentId).toBe(123);
    expect(blankOwner.agentId).toBe("");
    expect(absentOwner.agentId).toBe("ops");
    expect(getInvalidPersistedCronJobReason(numericOwner)).toBe("invalid-agent-id");
    expect(getInvalidPersistedCronJobReason(blankOwner)).toBe("invalid-agent-id");
    expect(getInvalidPersistedCronJobReason(absentOwner)).toBeNull();
    expect(() =>
      assertCronStoreCanPersist({
        version: 1,
        jobs: [numericOwner, blankOwner] as never,
      }),
    ).toThrow("Cannot persist cron store with 2 invalid job(s)");

    const { id: _id, ...legacyJobIdOwner } = persistedJob("legacy-job-id");
    legacyJobIdOwner.jobId = "legacy-job-id";
    expect(() =>
      assertCronStoreCanPersist({ version: 1, jobs: [legacyJobIdOwner] as never }),
    ).not.toThrow();
  });
});
