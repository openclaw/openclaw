import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { UpdateCheckResult } from "../infra/update-check.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
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
  target?: UpdateRunRecord["target"];
  before?: UpdateRunRecord["before"];
  after?: UpdateRunRecord["after"];
  verification?: UpdateRunRecord["verification"];
}) {
  now += 1000;
  const run = createUpdateRun({
    trigger: "cli",
    target: params.target ?? { kind: "git" },
    before: params.before,
  });
  if (params.after) {
    recordUpdateRunPhase(run.runId, "verifying", { after: params.after });
  }
  if (params.verification) {
    recordUpdateRunVerification(run.runId, params.verification);
  }
  for (const step of params.steps ?? []) {
    recordUpdateRunStep(run.runId, { endedAtMs: now, ...step });
  }
  return finishUpdateRun(run.runId, { status: params.status, reason: params.reason });
}
const readStatus = (fetchGit = false) =>
  getUpdateCheckResult({ timeoutMs: 5000, fetchGit, includeRegistry: false });

describe("status update ledger evidence", () => {
  it.each<{
    name: string;
    healthy?: boolean;
    target?: UpdateRunRecord["target"];
    before?: UpdateRunRecord["before"];
    after?: UpdateRunRecord["after"];
    verification?: UpdateRunRecord["verification"];
    server?: { version: string | null; buildId?: string };
    historical: boolean;
    detail?: string;
  }>([
    { name: "same version", healthy: true, server: { version: "2026.9.7" }, historical: true },
    {
      name: "old healthy version after a failed swap",
      healthy: true,
      after: { version: "2026.9.6" },
      verification: { runningVersion: "2026.9.6", versionMatch: false },
      server: { version: "2026.9.6" },
      historical: false,
      detail:
        "Gateway is still serving 2026.9.6; the update to 2026.9.7 did not complete — run `openclaw update`.",
    },
    {
      name: "unknown serving version",
      healthy: true,
      server: { version: null },
      historical: false,
      detail:
        "Gateway serving version is unknown; the update to 2026.9.7 is unverified — run `openclaw update`.",
    },
    {
      name: "after identity without an explicit target",
      healthy: true,
      target: {},
      after: { version: "2026.9.7" },
      verification: { runningVersion: "2026.9.6", versionMatch: false },
      server: { version: "2026.9.7" },
      historical: true,
    },
    {
      name: "rejected after identity without an independent target",
      healthy: true,
      target: {},
      after: { version: "2026.9.6" },
      verification: { runningVersion: "2026.9.6", versionMatch: false },
      server: { version: "2026.9.6" },
      historical: false,
      detail: "Gateway is serving 2026.9.6; the update target is unknown — run `openclaw update`.",
    },
    {
      name: "after identity with a different build from the rejected process",
      healthy: true,
      target: {},
      after: { version: "2026.9.7", buildId: "candidate" },
      verification: { runningVersion: "2026.9.7", runningBuildId: "previous", versionMatch: false },
      server: { version: "2026.9.7", buildId: "candidate" },
      historical: true,
    },
    {
      name: "verified target observation",
      healthy: true,
      target: {},
      verification: { runningVersion: "2026.9.7", runningBuildId: "candidate", versionMatch: true },
      server: { version: "2026.9.7", buildId: "candidate" },
      historical: true,
    },
    {
      name: "rejected build despite an explicit matching target version",
      healthy: true,
      after: { version: "2026.9.7", buildId: "previous" },
      verification: { runningVersion: "2026.9.7", runningBuildId: "previous", versionMatch: false },
      server: { version: "2026.9.7", buildId: "previous" },
      historical: false,
      detail:
        "Gateway is still serving 2026.9.7 (build previous); the intended build for 2026.9.7 is unverified — run `openclaw update`.",
    },
    {
      name: "same-version rollback with successful recovery verification",
      healthy: true,
      before: { version: "2026.9.7", buildId: "previous" },
      after: { version: "2026.9.7", buildId: "previous" },
      verification: {
        runningVersion: "2026.9.7",
        runningBuildId: "previous",
        versionMatch: true,
        recovery: {
          serviceRestartSafe: true,
          packageRollbackVerified: true,
          version: "2026.9.7",
          buildId: "previous",
          service: "healthy",
        },
      },
      server: { version: "2026.9.7", buildId: "previous" },
      historical: false,
      detail: "the intended build for 2026.9.7 is unverified",
    },
    {
      name: "same-version rollback with a file restoration receipt",
      healthy: true,
      before: { version: "2026.9.7", buildId: "previous" },
      after: { version: "2026.9.7", buildId: "previous" },
      verification: {
        runningVersion: "2026.9.7",
        runningBuildId: "previous",
        versionMatch: true,
        rollbackOutcome: {
          status: "succeeded",
          reason: "Previous package and configuration restored",
        },
      },
      server: { version: "2026.9.7", buildId: "previous" },
      historical: false,
      detail: "the intended build for 2026.9.7 is unverified",
    },
    {
      name: "distinct target version after package rollback",
      healthy: true,
      before: { version: "2026.9.6", buildId: "previous" },
      after: { version: "2026.9.6", buildId: "previous" },
      verification: {
        runningVersion: "2026.9.6",
        runningBuildId: "previous",
        versionMatch: true,
        recovery: {
          serviceRestartSafe: true,
          packageRollbackVerified: true,
          version: "2026.9.6",
          buildId: "previous",
          service: "healthy",
        },
      },
      server: { version: "2026.9.7", buildId: "candidate" },
      historical: true,
    },
    {
      name: "retained candidate build mismatch after failed rollback",
      healthy: true,
      before: { version: "2026.9.6", buildId: "previous" },
      after: { version: "2026.9.7", buildId: "candidate" },
      verification: {
        runningVersion: "2026.9.6",
        runningBuildId: "previous",
        versionMatch: false,
        rollbackOutcome: { status: "failed", reason: "Candidate remains active" },
      },
      server: { version: "2026.9.7", buildId: "other" },
      historical: false,
      detail:
        "Gateway is still serving 2026.9.7 (build other); the update to 2026.9.7 (build candidate) did not complete — run `openclaw update`.",
    },
    {
      name: "matching retained candidate build after failed rollback",
      healthy: true,
      before: { version: "2026.9.6", buildId: "previous" },
      after: { version: "2026.9.7", buildId: "candidate" },
      verification: {
        runningVersion: "2026.9.6",
        runningBuildId: "previous",
        versionMatch: false,
        rollbackOutcome: { status: "failed", reason: "Candidate remains active" },
      },
      server: { version: "2026.9.7", buildId: "candidate" },
      historical: true,
    },
    {
      name: "rejected candidate identity after failed rollback",
      healthy: true,
      before: { version: "2026.9.6", buildId: "previous" },
      after: { version: "2026.9.7", buildId: "rejected" },
      verification: {
        runningVersion: "2026.9.7",
        runningBuildId: "rejected",
        versionMatch: false,
        rollbackOutcome: { status: "failed", reason: "Candidate remains active" },
      },
      server: { version: "2026.9.7", buildId: "rejected" },
      historical: false,
      detail: "the intended build for 2026.9.7 is unverified",
    },
    {
      name: "rollback observation without an independent target",
      healthy: true,
      target: {},
      before: { version: "2026.9.7", buildId: "previous" },
      after: { version: "2026.9.7", buildId: "previous" },
      verification: {
        runningVersion: "2026.9.7",
        runningBuildId: "previous",
        versionMatch: true,
        recovery: {
          serviceRestartSafe: true,
          packageRollbackVerified: true,
          version: "2026.9.7",
          buildId: "previous",
          service: "healthy",
        },
      },
      server: { version: "2026.9.7", buildId: "previous" },
      historical: false,
      detail: "the update target is unknown",
    },
    {
      name: "same version with an older build",
      healthy: true,
      after: { version: "2026.9.7", buildId: "candidate" },
      server: { version: "2026.9.7", buildId: "previous" },
      historical: false,
      detail:
        "Gateway is still serving 2026.9.7 (build previous); the update to 2026.9.7 (build candidate) did not complete — run `openclaw update`.",
    },
    {
      name: "matching version and build",
      healthy: true,
      after: { version: "2026.9.7", buildId: "candidate" },
      server: { version: "2026.9.7", buildId: "candidate" },
      historical: true,
    },
    {
      name: "matching version with no exposed serving build",
      healthy: true,
      after: { version: "2026.9.7", buildId: "candidate" },
      server: { version: "2026.9.7" },
      historical: true,
    },
    {
      name: "unhealthy target version",
      healthy: false,
      server: { version: "2026.9.7" },
      historical: false,
    },
    { name: "unknown health", server: { version: "2026.9.7" }, historical: false },
  ])(
    "preserves the update verdict for $name",
    async ({ healthy, target, before, after, verification, server, historical, detail }) => {
      const run = recordRun({
        status: "failed",
        reason: "post-update-failed",
        target: target ?? { version: "2026.9.7" },
        before,
        after,
        verification,
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
      const rows = await buildStatusUpdateRows(null, {
        localGatewayHealthy: healthy,
        gatewayServer: server,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.Item).toBe("Update run");
      if (historical) {
        expect(rows[0]?.Value).toBe(
          "Last update run failed (post-update-failed) — Gateway is serving 2026.9.7; run `openclaw update` to clear the record.",
        );
      } else {
        expect(rows[0]?.Value).toContain(
          "⚠️ OpenClaw update failed: post-update-failed. Gateway did not settle; startup phase: waiting for managed service",
        );
        if (detail) {
          expect(rows[0]?.Value).toContain(detail);
        }
      }
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
