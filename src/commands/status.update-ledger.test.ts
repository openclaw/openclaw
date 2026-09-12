import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import type { UpdateRunRecord, UpdateRunStep } from "../infra/update-run-record.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { formatUpdateOneLiner, getUpdateCheckResult } from "./status.update.js";

const mocks = vi.hoisted(() => ({ checkUpdateStatus: vi.fn() }));
vi.mock(import("../infra/update-check.js"), async (original) => ({
  ...(await original()),
  checkUpdateStatus: mocks.checkUpdateStatus,
}));
vi.mock(import("../infra/openclaw-root.js"), async (original) => ({
  ...(await original()),
  resolveOpenClawPackageRoot: async () => "/repo",
}));

const tempDirs = createTempDirTracker();
let now: number;
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-status-ledger-"));
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  mocks.checkUpdateStatus.mockReset().mockImplementation(
    async () =>
      ({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "abc123",
          tag: null,
          branch: "main",
          upstream: "origin/main",
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: null,
        },
      }) satisfies UpdateCheckResult,
  );
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

function recordRun(params: {
  status: Exclude<UpdateRunRecord["status"], "running">;
  reason?: string;
  steps?: UpdateRunStep[];
}) {
  now += 1000;
  const run = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
  for (const step of params.steps ?? []) {
    recordUpdateRunStep(run.runId, { endedAtMs: now, ...step });
  }
  return finishUpdateRun(run.runId, { status: params.status, reason: params.reason });
}
const readStatus = (fetchGit = false) =>
  getUpdateCheckResult({ timeoutMs: 5000, fetchGit, includeRegistry: false });

describe("status update ledger evidence", () => {
  it("keeps the existing cached output when there is no ledger", async () => {
    const update = await readStatus();
    expect(update.git).not.toHaveProperty("stale");
    expect(formatUpdateOneLiner(update)).toContain("up to date");
  });

  it.each([
    "fetch-failed",
    "git fetch",
    "git target inspection fetch",
    "git import admitted target",
  ])("reports a newer failure recorded as %s", async (failure) => {
    recordRun({ status: "succeeded", steps: [{ step: "git fetch", status: "completed" }] });
    const run = recordRun({
      status: "failed",
      ...(failure === "fetch-failed"
        ? { reason: failure }
        : {
            steps: [{ step: failure, status: "failed", detail: "network unavailable" }],
          }),
    });
    now += 300_000;
    const update = await readStatus();
    expect(update.git).toMatchObject({
      ahead: 0,
      behind: 0,
      countsCached: true,
      stale: {
        reason: "fetch-failed",
        failedAtMs: run.finishedAtMs,
        runId: run.runId,
        detail: failure === "fetch-failed" ? "fetch-failed" : "network error",
      },
    });
    expect(formatUpdateOneLiner(update)).toContain(
      "update check stale: last update fetch failed 5m ago",
    );
    expect(formatUpdateOneLiner(update)).toContain("cached: ahead 0, behind 0");
    expect(formatUpdateOneLiner(update)).not.toContain("up to date");
    expect(mocks.checkUpdateStatus).toHaveBeenCalledWith(
      expect.objectContaining({ fetchGit: false }),
    );
  });

  it.each(["succeeded", "skipped", "rolled-back", "failed"] as const)(
    "clears the failure after a later completed fetch even when the run is %s",
    async (status) => {
      recordRun({ status: "failed", reason: "fetch-failed" });
      recordRun({ status, steps: [{ step: "git target inspection fetch", status: "completed" }] });
      const update = await readStatus();
      expect(update.git).not.toHaveProperty("stale");
      expect(update.git).not.toHaveProperty("countsCached");
      expect(formatUpdateOneLiner(update)).toContain("up to date");
    },
  );

  it("retains the failure across later runs that never reached fetch, beyond a history page", async () => {
    const failed = recordRun({ status: "failed", reason: "fetch-failed" });
    for (let index = 0; index < 101; index++) {
      recordRun({ status: "skipped", reason: "dirty" });
    }
    recordRun({ status: "succeeded" });
    expect((await readStatus()).git?.stale?.runId).toBe(failed.runId);
  });

  it("preserves a tag fetch failure after a completed branch fetch in the same run", async () => {
    recordRun({
      status: "failed",
      steps: [
        { step: "git fetch", status: "completed" },
        { step: "git fetch tags origin", status: "failed", detail: "would clobber existing tag" },
      ],
    });
    expect((await readStatus()).git?.stale?.detail).toBe("tag conflict");
  });

  it.each(["step", "reason"] as const)(
    "uses fetch outcome time across overlapping runs with a %s failure",
    async (failureKind) => {
      const older = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      now += 1000;
      const newer = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      now += 1000;
      recordUpdateRunStep(newer.runId, {
        step: "git fetch",
        status: "completed",
        endedAtMs: now,
      });
      now += 1000;
      const failedAtMs = now;
      if (failureKind === "step") {
        recordUpdateRunStep(older.runId, {
          step: "git fetch",
          status: "failed",
          endedAtMs: now,
          detail: "network unavailable",
        });
      } else {
        finishUpdateRun(older.runId, { status: "failed", reason: "fetch-failed" });
      }
      // Finishing an unrelated build does not make its earlier fetch more recent.
      now += 1000;
      recordUpdateRunStep(newer.runId, { step: "build", status: "completed", endedAtMs: now });
      finishUpdateRun(newer.runId, { status: "succeeded" });
      expect((await readStatus()).git?.stale).toMatchObject({ runId: older.runId, failedAtMs });
      expect(formatUpdateOneLiner(await readStatus())).not.toContain("up to date");
    },
  );

  it.each(["succeeded", "failed", "rolled-back", "skipped"] as const)(
    "clears failure when an older-created run fetches later and ends %s",
    async (status) => {
      const older = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      now += 1000;
      const newer = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      now += 1000;
      recordUpdateRunStep(newer.runId, {
        step: "git fetch",
        status: "failed",
        endedAtMs: now,
      });
      now += 1000;
      recordUpdateRunStep(older.runId, {
        step: "git target inspection fetch",
        status: "completed",
        endedAtMs: now,
      });
      finishUpdateRun(older.runId, { status });
      // Later run finalization must not re-date the earlier failed fetch.
      now += 1000;
      finishUpdateRun(newer.runId, { status: "failed", reason: "fetch-failed" });
      const update = await readStatus();
      expect(update.git).not.toHaveProperty("stale");
      expect(formatUpdateOneLiner(update)).toContain("up to date");
    },
  );

  it.each([true, false])(
    "requires a strictly later completion to clear equal-time failure (failure created first: %s)",
    async (failureFirst) => {
      const first = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      now += 1000;
      const second = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      const failed = failureFirst ? first : second;
      const completed = failureFirst ? second : first;
      now += 1000;
      recordUpdateRunStep(failed.runId, { step: "git fetch", status: "failed", endedAtMs: now });
      recordUpdateRunStep(completed.runId, {
        step: "git fetch",
        status: "completed",
        endedAtMs: now,
      });
      expect((await readStatus()).git?.stale?.runId).toBe(failed.runId);
    },
  );

  it.each(["running", "succeeded"] as const)(
    "does not re-date an untimestamped fetch from later %s run activity",
    async (status) => {
      const older = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      now += 1000;
      recordUpdateRunStep(older.runId, { step: "git fetch", status: "completed" });
      now += 1000;
      const failed = recordRun({ status: "failed", reason: "fetch-failed" });
      now += 1000;
      if (status === "running") {
        recordUpdateRunStep(older.runId, { step: "build", status: "completed", endedAtMs: now });
      } else {
        finishUpdateRun(older.runId, { status });
      }
      expect((await readStatus()).git?.stale?.runId).toBe(failed.runId);
    },
  );

  it("leaves fresh checks to Git without clearing the recorded failure", async () => {
    recordRun({ status: "failed", reason: "fetch-failed" });
    expect((await readStatus(true)).git).not.toHaveProperty("stale");
    expect(mocks.checkUpdateStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ fetchGit: true }),
    );
    expect((await readStatus()).git?.stale).toBeDefined();
  });
});
