import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../infra/update-run-ledger.js";
import type { UpdateRunRecord, UpdateRunStep } from "../infra/update-run-record.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { buildStatusUpdateRows } from "./status-update-restart.ts";
import {
  formatUpdateAvailableHint,
  formatUpdateOneLiner,
  getUpdateCheckResult,
} from "./status.update.js";

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
        git: { ...cleanGit, root: "/repo", sha: "abc123", fetchOk: null },
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
  it.each([true, false, undefined])(
    "separates failed history from current local Gateway health (%s)",
    async (localGatewayHealthy) => {
      const run = recordRun({
        status: "failed",
        reason: "post-update-failed",
        steps: [
          {
            step: "gateway verification",
            status: "failed",
            failureFacts: [
              {
                check: "gateway",
                code: "post-update-failed",
                message: "Gateway did not settle; startup phase: waiting for managed service",
              },
            ],
          },
        ],
      });
      const saved = getUpdateRun(run.runId);
      const rows = await buildStatusUpdateRows(null, { localGatewayHealthy });
      expect(rows).toEqual([
        {
          Item: "Update run",
          Value: localGatewayHealthy
            ? "Last update run failed (post-update-failed) — Gateway is currently healthy; run `openclaw update` to reconcile."
            : "⚠️ OpenClaw update failed: post-update-failed. Gateway did not settle; startup phase: waiting for managed service",
        },
      ]);
      expect(getUpdateRun(run.runId)).toEqual(saved);
    },
  );

  it("does not replace an active update with a historical failure's current-health note", async () => {
    recordRun({ status: "failed", reason: "post-update-failed" });
    const active = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
    recordUpdateRunPhase(active.runId, "verifying");
    const rows = await buildStatusUpdateRows(null, { localGatewayHealthy: true });
    expect(rows[0]).toEqual({
      Item: "Update run",
      Value: "⬆️ OpenClaw update in progress: verifying.",
    });
  });

  it("reports a newer fetch failure using cached counts", async () => {
    recordRun({ status: "succeeded", steps: [{ step: "git fetch", status: "completed" }] });
    const run = recordRun({
      status: "failed",
      steps: [
        { step: "git import admitted target", status: "failed", detail: "network unavailable" },
      ],
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
        detail: "network error",
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

  it("uses fetch outcome time across overlapping runs", async () => {
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
    recordUpdateRunStep(older.runId, {
      step: "git fetch",
      status: "failed",
      endedAtMs: now,
      detail: "network unavailable",
    });
    // Finishing an unrelated build does not make its earlier fetch more recent.
    now += 1000;
    recordUpdateRunStep(newer.runId, { step: "build", status: "completed", endedAtMs: now });
    finishUpdateRun(newer.runId, { status: "succeeded" });
    expect((await readStatus()).git?.stale).toMatchObject({ runId: older.runId, failedAtMs });
    expect(formatUpdateOneLiner(await readStatus())).not.toContain("up to date");
  });

  it("clears failure when an older-created run fetches later despite its failed result", async () => {
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
    finishUpdateRun(older.runId, { status: "failed" });
    // Later run finalization must not re-date the earlier failed fetch.
    now += 1000;
    finishUpdateRun(newer.runId, { status: "failed", reason: "fetch-failed" });
    const update = await readStatus();
    expect(update.git).not.toHaveProperty("stale");
    expect(formatUpdateOneLiner(update)).toContain("up to date");
  });

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

  it("does not re-date an untimestamped fetch from later run activity", async () => {
    const older = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
    now += 1000;
    recordUpdateRunStep(older.runId, { step: "git fetch", status: "completed" });
    now += 1000;
    const failed = recordRun({ status: "failed", reason: "fetch-failed" });
    now += 1000;
    recordUpdateRunStep(older.runId, { step: "build", status: "completed", endedAtMs: now });
    expect((await readStatus()).git?.stale?.runId).toBe(failed.runId);
  });

  it("leaves fresh checks to Git without clearing the recorded failure", async () => {
    recordRun({ status: "failed", reason: "fetch-failed" });
    expect((await readStatus(true)).git).not.toHaveProperty("stale");
    expect(mocks.checkUpdateStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ fetchGit: true }),
    );
    expect((await readStatus()).git?.stale).toBeDefined();
  });
});

function buildUpdate(partial: Partial<UpdateCheckResult>): UpdateCheckResult {
  return {
    root: null,
    installKind: "unknown",
    packageManager: "unknown",
    ...partial,
  };
}

const cleanGit: NonNullable<UpdateCheckResult["git"]> = {
  root: "/tmp/repo",
  sha: null,
  tag: null,
  branch: "main",
  upstream: "origin/main",
  dirty: false,
  ahead: 0,
  behind: 0,
  fetchOk: true,
};

describe("formatUpdateOneLiner", () => {
  it.each(["def987654321", "abc123456789"])("compares built commit %s with HEAD", (builtSha) => {
    const update = buildUpdate({
      installKind: "git",
      git: { ...cleanGit, sha: "abc123456789", builtSha },
    });
    if (builtSha === "def987654321") {
      expect(formatUpdateOneLiner(update)).toContain(
        "stale build (running def98765, run pnpm build)",
      );
    } else {
      expect(formatUpdateOneLiner(update)).not.toContain("stale build");
    }
  });

  it("renders git status and registry summary without duplicating up to date", () => {
    const update = buildUpdate({
      installKind: "git",
      git: {
        ...cleanGit,
        sha: "abc123456789",
        dirty: true,
        behind: 2,
      },
      registry: { latestVersion: VERSION },
      deps: {
        manager: "pnpm",
        status: "ok",
        lockfilePath: "pnpm-lock.yaml",
        markerPath: "node_modules/.modules.yaml",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe(
      `Update: git main · ↔ origin/main · dirty · behind 2 · npm latest ${VERSION} · deps ok`,
    );
  });

  it("renders beta registry tags instead of calling them npm latest", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: VERSION, tag: "beta" },
    });

    expect(formatUpdateOneLiner(update)).toBe(`Update: npm · up to date · npm beta ${VERSION}`);
  });

  it("renders an installed version newer than extended-stable as ahead", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: "1.0.0", tag: "extended-stable" },
    });

    expect(formatUpdateOneLiner(update)).toBe("Update: npm · ahead of extended-stable (1.0.0)");
  });

  it("renders structured extended-stable resolver failures", () => {
    const update = buildUpdate({
      installKind: "git",
      packageManager: "pnpm",
      registry: {
        latestVersion: null,
        tag: "extended-stable",
        error: "unsupported_git_channel",
        reason: "unsupported_git_channel",
      },
    });

    expect(formatUpdateOneLiner(update)).toContain("extended-stable requires a package install");
  });

  it("renders package-manager mode with registry error", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: null, error: "offline" },
      deps: {
        manager: "npm",
        status: "missing",
        lockfilePath: "package-lock.json",
        markerPath: "node_modules",
      },
    });

    expect(formatUpdateOneLiner(update)).toBe("Update: npm · npm latest unknown · deps missing");
  });

  it("returns null when no update is available", () => {
    const update = buildUpdate({
      installKind: "package",
      packageManager: "pnpm",
      registry: { latestVersion: VERSION },
    });

    expect(formatUpdateAvailableHint(update)).toBeNull();
  });

  it.each([false, true])("renders registry updates with cached git=%s", (cached) => {
    const latestVersion = `${Number(VERSION.split(".")[0]) + 1}.0.0`;
    const update = buildUpdate({
      installKind: cached ? "git" : "package",
      git: cached ? { ...cleanGit, behind: 2, fetchOk: null, countsCached: true } : undefined,
      registry: { latestVersion },
    });

    expect(formatUpdateAvailableHint(update)).toBe(
      `Update available (${cached ? "git behind 2 (cached) · " : ""}npm ${latestVersion}). Run: openclaw update`,
    );
  });
});
