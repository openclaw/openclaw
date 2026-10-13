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

const target = { version: "2026.9.7" };
const previous = { ...target, buildId: "previous" };
const oldPrevious = { version: "2026.9.6", buildId: "previous" };
const candidate = { ...target, buildId: "candidate" };
const rejected = { ...target, buildId: "rejected" };
const failedRollback = { status: "failed", reason: "Candidate remains active" } as const;
const observed = (identity: { version: string; buildId?: string }, versionMatch: boolean) => ({
  runningVersion: identity.version,
  runningBuildId: identity.buildId,
  versionMatch,
});
const recovered = (identity: {
  version: string;
  buildId: string;
}): UpdateRunRecord["verification"] => ({
  ...observed(identity, true),
  recovery: {
    serviceRestartSafe: true,
    packageRollbackVerified: true,
    ...identity,
    service: "healthy" as const,
  },
});

describe("status update ledger evidence", () => {
  it.each<{
    name: string;
    healthy?: boolean | null;
    target?: UpdateRunRecord["target"];
    before?: UpdateRunRecord["before"];
    after?: UpdateRunRecord["after"];
    verification?: UpdateRunRecord["verification"];
    server?: { version: string | null; buildId?: string };
    historical?: boolean;
    detail?: string;
  }>([
    { name: "same version", historical: true },
    {
      name: "old healthy version after a failed swap",
      after: { version: "2026.9.6" },
      verification: observed({ version: "2026.9.6" }, false),
      server: { version: "2026.9.6" },
      detail:
        "Gateway is still serving 2026.9.6; the update to 2026.9.7 did not complete — run `openclaw update`.",
    },
    {
      name: "unknown serving version",
      server: { version: null },
      detail:
        "Gateway serving version is unknown; the update to 2026.9.7 is unverified — run `openclaw update`.",
    },
    {
      name: "after identity without an explicit target",
      target: {},
      after: target,
      verification: observed({ version: "2026.9.6" }, false),
      historical: true,
    },
    {
      name: "rejected after identity without an independent target",
      target: {},
      after: { version: "2026.9.6" },
      verification: observed({ version: "2026.9.6" }, false),
      server: { version: "2026.9.6" },
      detail: "Gateway is serving 2026.9.6; the update target is unknown — run `openclaw update`.",
    },
    {
      name: "after identity with a different build from the rejected process",
      target: {},
      after: candidate,
      verification: observed(previous, false),
      server: candidate,
      historical: true,
    },
    {
      name: "verified target observation",
      target: {},
      verification: observed(candidate, true),
      server: candidate,
      historical: true,
    },
    {
      name: "rejected build despite an explicit matching target version",
      after: previous,
      verification: observed(previous, false),
      server: previous,
      detail:
        "Gateway is still serving 2026.9.7 (build previous); the intended build for 2026.9.7 is unverified — run `openclaw update`.",
    },
    {
      name: "same-version rollback with successful recovery verification",
      before: previous,
      after: previous,
      verification: recovered(previous),
      server: previous,
      detail: "the intended build for 2026.9.7 is unverified",
    },
    {
      name: "same-version rollback with a file restoration receipt",
      before: previous,
      after: previous,
      verification: {
        ...observed(previous, true),
        rollbackOutcome: {
          status: "succeeded",
          reason: "Previous package and configuration restored",
        },
      },
      server: previous,
      detail: "the intended build for 2026.9.7 is unverified",
    },
    {
      name: "distinct target version after package rollback",
      before: oldPrevious,
      after: oldPrevious,
      verification: recovered(oldPrevious),
      server: candidate,
      historical: true,
    },
    {
      name: "retained candidate build mismatch after failed rollback",
      before: oldPrevious,
      after: candidate,
      verification: {
        ...observed(oldPrevious, false),
        rollbackOutcome: failedRollback,
      },
      server: { version: "2026.9.7", buildId: "other" },
      detail:
        "Gateway is still serving 2026.9.7 (build other); the update to 2026.9.7 (build candidate) did not complete — run `openclaw update`.",
    },
    {
      name: "matching retained candidate build after failed rollback",
      before: oldPrevious,
      after: candidate,
      verification: {
        ...observed(oldPrevious, false),
        rollbackOutcome: failedRollback,
      },
      server: candidate,
      historical: true,
    },
    {
      name: "rejected candidate identity after failed rollback",
      before: oldPrevious,
      after: rejected,
      verification: {
        ...observed(rejected, false),
        rollbackOutcome: failedRollback,
      },
      server: rejected,
      detail: "the intended build for 2026.9.7 is unverified",
    },
    {
      name: "rollback observation without an independent target",
      target: {},
      before: previous,
      after: previous,
      verification: recovered(previous),
      server: previous,
      detail: "the update target is unknown",
    },
    {
      name: "same version with an older build",
      after: candidate,
      server: previous,
      detail:
        "Gateway is still serving 2026.9.7 (build previous); the update to 2026.9.7 (build candidate) did not complete — run `openclaw update`.",
    },
    {
      name: "matching version and build",
      after: candidate,
      server: candidate,
      historical: true,
    },
    {
      name: "matching version with no exposed serving build",
      after: candidate,
      historical: true,
    },
    {
      name: "unhealthy target version",
      healthy: false,
    },
    { name: "unknown health", healthy: null },
  ])(
    "preserves the update verdict for $name",
    async ({
      healthy = true,
      target: runTarget,
      before,
      after,
      verification,
      server = target,
      historical = false,
      detail,
    }) => {
      const run = recordRun({
        status: "failed",
        reason: "post-update-failed",
        target: runTarget ?? target,
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
        localGatewayHealthy: healthy ?? undefined,
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

  it.each([false, true])(
    "orders overlapping runs by fetch outcome (later completion: %s)",
    async (laterCompletion) => {
      const older = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      now += 1000;
      const newer = createUpdateRun({ trigger: "cli", target: { kind: "git" } });
      now += 1000;
      recordUpdateRunStep(newer.runId, {
        step: "git fetch",
        status: laterCompletion ? "failed" : "completed",
        endedAtMs: now,
      });
      now += 1000;
      const failedAtMs = now;
      recordUpdateRunStep(older.runId, {
        step: laterCompletion ? "git target inspection fetch" : "git fetch",
        status: laterCompletion ? "completed" : "failed",
        endedAtMs: now,
        ...(laterCompletion ? {} : { detail: "network unavailable" }),
      });
      if (laterCompletion) {
        finishUpdateRun(older.runId, { status: "failed" });
        now += 1000;
        finishUpdateRun(newer.runId, { status: "failed", reason: "fetch-failed" });
      } else {
        now += 1000;
        recordUpdateRunStep(newer.runId, { step: "build", status: "completed", endedAtMs: now });
        finishUpdateRun(newer.runId, { status: "succeeded" });
      }
      const update = await readStatus();
      if (laterCompletion) {
        expect(update.git).not.toHaveProperty("stale");
        expect(formatUpdateOneLiner(update)).toContain("up to date");
      } else {
        expect(update.git?.stale).toMatchObject({ runId: older.runId, failedAtMs });
        expect(formatUpdateOneLiner(update)).not.toContain("up to date");
      }
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

describe("update formatting", () => {
  it.each<{
    name: string;
    update: Partial<UpdateCheckResult>;
    expected?: string;
    contains?: string;
    excludes?: string;
  }>([
    {
      name: "stale built commit",
      update: {
        installKind: "git",
        git: { ...cleanGit, sha: "abc123456789", builtSha: "def987654321" },
      },
      contains: "stale build (running def98765, run pnpm build)",
    },
    {
      name: "current built commit",
      update: {
        installKind: "git",
        git: { ...cleanGit, sha: "abc123456789", builtSha: "abc123456789" },
      },
      excludes: "stale build",
    },
    {
      name: "git status with registry summary",
      update: {
        installKind: "git",
        git: { ...cleanGit, sha: "abc123456789", dirty: true, behind: 2 },
        registry: { latestVersion: VERSION },
        deps: {
          manager: "pnpm",
          status: "ok",
          lockfilePath: "pnpm-lock.yaml",
          markerPath: "node_modules/.modules.yaml",
        },
      },
      expected: `Update: git main · ↔ origin/main · dirty · behind 2 · npm latest ${VERSION} · deps ok`,
    },
    {
      name: "beta registry tag",
      update: {
        installKind: "package",
        packageManager: "npm",
        registry: { latestVersion: VERSION, tag: "beta" },
      },
      expected: `Update: npm · up to date · npm beta ${VERSION}`,
    },
    {
      name: "installed version ahead of extended-stable",
      update: {
        installKind: "package",
        packageManager: "npm",
        registry: { latestVersion: "1.0.0", tag: "extended-stable" },
      },
      expected: "Update: npm · ahead of extended-stable (1.0.0)",
    },
    {
      name: "structured extended-stable resolver failure",
      update: {
        installKind: "git",
        packageManager: "pnpm",
        registry: {
          latestVersion: null,
          tag: "extended-stable",
          error: "unsupported_git_channel",
          reason: "unsupported_git_channel",
        },
      },
      contains: "extended-stable requires a package install",
    },
    {
      name: "package-manager registry error",
      update: {
        installKind: "package",
        packageManager: "npm",
        registry: { latestVersion: null, error: "offline" },
        deps: {
          manager: "npm",
          status: "missing",
          lockfilePath: "package-lock.json",
          markerPath: "node_modules",
        },
      },
      expected: "Update: npm · npm latest unknown · deps missing",
    },
  ])("renders $name", ({ update, expected, contains, excludes }) => {
    const line = formatUpdateOneLiner(buildUpdate(update));
    if (expected !== undefined) {
      expect(line).toBe(expected);
    }
    if (contains !== undefined) {
      expect(line).toContain(contains);
    }
    if (excludes !== undefined) {
      expect(line).not.toContain(excludes);
    }
  });

  it.each(["none", "registry", "cached-git"])("renders the %s update hint", (mode) => {
    const cached = mode === "cached-git";
    const latestVersion = mode === "none" ? VERSION : `${Number(VERSION.split(".")[0]) + 1}.0.0`;
    const update = buildUpdate({
      installKind: cached ? "git" : "package",
      packageManager: mode === "none" ? "pnpm" : "unknown",
      git: cached ? { ...cleanGit, behind: 2, fetchOk: null, countsCached: true } : undefined,
      registry: { latestVersion },
    });
    expect(formatUpdateAvailableHint(update)).toBe(
      mode === "none"
        ? null
        : `Update available (${cached ? "git behind 2 (cached) · " : ""}npm ${latestVersion}). Run: openclaw update`,
    );
  });
});
