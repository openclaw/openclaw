import { expect, it } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";
import { admitScheduledOccurrence } from "./execution-context-admission.js";
import type { CronStoredJob } from "./types.js";

it.each([
  undefined,
  { version: 1 },
  { version: 1, snapshot: null },
  { version: 1, snapshot: { openclawIdPrincipal: { kind: "member" } } },
])("refuses an undecodable stored authority without admitting a guest run: %j", async (source) => {
  const job: CronStoredJob = {
    ...makeCronJob({}),
    createdActor: { type: "human", source: "profile", id: "guest" },
    operatorSource: { executionRevision: "invalid", source } as never,
  };
  const occurrence = await admitScheduledOccurrence({
    cfg: {},
    job,
    agentId: "main",
    trigger: "cron",
  });
  try {
    const minted = occurrence.mint({
      cfg: {},
      agentId: "main",
      runId: "invalid-run",
      runSessionKey: "agent:main:cron:job-1:run:invalid",
    });
    expect(minted.result).toEqual({ status: "fail", error: "stored operator source is invalid" });
    expect(minted.current()).toBeUndefined();
    minted.release();
  } finally {
    occurrence.release();
  }
});
