import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { resolveCronJobTimeoutMs } from "./timeout-policy.js";

/** Managed archives need hours; pin the declared budget, not the constant, so a wrong value still fails. */
const ARCHIVE_BUDGET_MS = 24 * 60 * 60 * 1000;

function makeJob(payload: CronJob["payload"]): CronJob {
  const sessionTarget = payload.kind === "agentTurn" ? "isolated" : "main";
  return {
    id: "job-1",
    name: "job",
    createdAtMs: 0,
    updatedAtMs: 0,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget,
    wakeMode: "next-heartbeat",
    payload,
    state: {},
  };
}

function makeOffsiteBackupJob(payload: CronJob["payload"]): CronJob {
  return {
    ...makeJob(payload),
    name: "openclaw-backup-offsite-scheduled",
    declarationKey: "openclaw-backup-offsite-scheduled",
  };
}

describe("timeout-policy", () => {
  it("disables timeout when timeoutSeconds <= 0", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeJob({ kind: "agentTurn", message: "hi", timeoutSeconds: 0 }),
    );
    expect(timeout).toBeUndefined();
  });

  it("gives a managed backup schedule the archive-sized budget instead of the generic command deadline", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeOffsiteBackupJob({
        kind: "command",
        argv: ["openclaw", "backup", "create", "--to", "archive"],
      }),
    );
    expect(timeout).toBe(ARCHIVE_BUDGET_MS);
    expect(timeout).not.toBe(10 * 60_000);
  });

  it("keeps the generic command deadline for an unmanaged command job", () => {
    const timeout = resolveCronJobTimeoutMs(makeJob({ kind: "command", argv: ["echo", "hi"] }));
    expect(timeout).toBe(10 * 60_000);
  });

  it("still honors an explicit backup schedule timeout", () => {
    const timeout = resolveCronJobTimeoutMs(
      makeOffsiteBackupJob({
        kind: "command",
        argv: ["openclaw", "backup", "create", "--to", "archive"],
        timeoutSeconds: 90,
      }),
    );
    expect(timeout).toBe(90_000);
  });
});
