import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target-paths.js";
import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordPlannedMigrationMoves,
  recordCompletedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
  type SessionSqliteMigrationMove,
} from "../infra/session-sqlite-migration-manifest.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { UPDATE_CAPTURE_PRIVACY_MARKER } from "../infra/update-capture-privacy-marker.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { collectRecoveryDiskUsage, formatRecoveryDiskUsage } from "./recovery-disk-usage.js";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.js";
import { createStatusCommandOverviewRowsParams } from "./status.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

it("reports logical bytes and distinct eligibility counts by kind through status text", async () => {
  await withOpenClawTestState({ label: "recovery-usage", applyEnv: true }, async (state) => {
    const root = resolveUpdateCaptureRoot(state.stateDir);
    fs.mkdirSync(root, { recursive: true });
    const captures: Array<{ runId: string; bytes: number }> = [];
    {
      using clock = vi.spyOn(Date, "now");
      for (const now of [1_000, 3_000]) {
        clock.mockReturnValue(now);
        const { runId } = createUpdateRun({ trigger: "cli" }, { env: state.env });
        clock.mockReturnValue(now + 1_000);
        finishUpdateRun(runId, { status: "succeeded" }, { env: state.env });
        captures.push({ runId, bytes: now === 1_000 ? 11 : 13 });
      }
    }
    for (const { runId, bytes } of captures) {
      fs.mkdirSync(path.join(root, runId));
      fs.writeFileSync(path.join(root, runId, UPDATE_CAPTURE_PRIVACY_MARKER), "");
      fs.writeFileSync(path.join(root, runId, "original"), Buffer.alloc(bytes));
    }
    const doctor = `doctor-${randomUUID()}`;
    fs.mkdirSync(path.join(root, doctor));
    fs.writeFileSync(path.join(root, doctor, "original"), Buffer.alloc(17));
    fs.mkdirSync(state.statePath("state"), { recursive: true });
    const original = state.statePath("state", "openclaw.sqlite.pre-startup-migration-old.bak");
    fs.writeFileSync(original, Buffer.alloc(19));
    const usage = collectRecoveryDiskUsage({ cfg: {}, env: state.env });
    expect(usage.incomplete).toBe(false);
    expect(usage.total).toEqual({
      count: 4,
      logicalBytes: 60,
      retirable: { count: 1, logicalBytes: 11 },
      protected: { count: 1, logicalBytes: 13 },
      unmanifestedOrOrphan: { count: 2, logicalBytes: 36 },
    });
    expect(usage.byKind.updateCaptures).toMatchObject({ count: 2, logicalBytes: 24 });
    expect(usage.byKind.doctorCaptures).toMatchObject({ count: 1, logicalBytes: 17 });
    expect(usage.byKind.migrationOriginals).toMatchObject({ count: 1, logicalBytes: 19 });
    const params = createStatusCommandOverviewRowsParams();
    const row = buildStatusCommandOverviewRows({
      ...params,
      surface: { ...params.surface, recoveryCopies: usage },
    }).find(({ Item }) => Item === "Recovery copies (local)");
    expect(row?.Value).toContain(
      "60 logical bytes in 4 copies; 1 retirable, 1 protected, 2 unmanifested/orphan",
    );
    expect(fs.readFileSync(original)).toEqual(Buffer.alloc(19));
  });
});

it.each(["entry-limit", "metadata-byte-limit", "time-limit"] as const)(
  "returns an honest incomplete result at %s without changing recovery files",
  async (reason) => {
    await withOpenClawTestState({ label: "recovery-usage-bounded" }, async (state) => {
      fs.mkdirSync(state.statePath("state"), { recursive: true });
      if (reason === "metadata-byte-limit") {
        // This deliberately invalid, oversized ledger must never be copied/opened for status.
        fs.writeFileSync(
          state.statePath("state", "openclaw.sqlite"),
          Buffer.alloc(3 * 1024 * 1024),
        );
      }
      const original = state.statePath("state", "openclaw.sqlite.pre-startup-migration-old.bak");
      fs.writeFileSync(original, "keep me");
      if (reason === "entry-limit") {
        for (let index = 0; index < 2_001; index++) {
          fs.writeFileSync(
            state.statePath("state", `openclaw.sqlite.pre-startup-migration-${index}.bak`),
            "",
          );
        }
      }
      using clock = vi
        .spyOn(performance, "now")
        .mockReturnValue(reason === "time-limit" ? 1_000 : 0);
      if (reason === "time-limit") {
        clock.mockReturnValueOnce(0);
      }
      const usage = collectRecoveryDiskUsage({ cfg: {}, env: state.env });
      expect(usage.incomplete).toBe(true);
      expect(usage.incompleteReasons).toContain(reason);
      expect(formatRecoveryDiskUsage(usage)).toContain("Incomplete estimate");
      expect(fs.readFileSync(original, "utf8")).toBe("keep me");
      if (reason === "metadata-byte-limit") {
        expect(usage.total).toMatchObject({ count: 1, logicalBytes: 7 });
      }
    });
  },
);

it("includes the same read-only recovery inventory in Doctor lint JSON", async () => {
  await withOpenClawTestState({ label: "doctor-recovery-usage", applyEnv: true }, async (state) => {
    fs.mkdirSync(state.statePath("state"), { recursive: true });
    const original = state.statePath("state", "openclaw.sqlite.pre-startup-migration-old.bak");
    fs.writeFileSync(original, "original");
    const output: string[] = [];
    using stdout = vi.spyOn(process.stdout, "write");
    stdout.mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await runDoctorLintCli(createTestRuntime(), {
      json: true,
      onlyIds: ["core/doctor/disk-space"],
    });
    const result = JSON.parse(output.find((line) => line.startsWith("{"))!);
    expect(result.recoveryCopies).toMatchObject({
      scope: "local",
      incomplete: false,
      total: { count: 1, logicalBytes: 8, unmanifestedOrOrphan: { count: 1, logicalBytes: 8 } },
    });
    expect(fs.readFileSync(original, "utf8")).toBe("original");
  });
});

it("keeps originals protected after incomplete dependency discovery skips another manifest", async () => {
  await withOpenClawTestState(
    { label: "recovery-partial-dependencies", applyEnv: true },
    async (state) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      fs.mkdirSync(state.sessionsDir(), { recursive: true });
      const target = {
        agentId: "main",
        storePath,
        sqlitePath: resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath).path,
      };
      const archiveDir = path.join(
        path.dirname(state.sessionsDir()),
        "session-sqlite-import-archive",
      );
      fs.mkdirSync(archiveDir);
      const archivePath = path.join(archiveDir, "old.jsonl.imported-1");
      fs.writeFileSync(archivePath, "original");
      const move: SessionSqliteMigrationMove = {
        kind: "transcript",
        sourcePath: path.join(state.sessionsDir(), "old.jsonl"),
        archivePath,
        artifact: {
          identity: readMigrationArtifactIdentity(archivePath),
          classification: "imported",
          reason: "verified-import",
          dependencies: [],
          disposal: { state: "retained" },
        },
      };
      const completed = createSessionSqliteMigrationRun(state.env, [target]);
      recordPlannedMigrationMoves(completed, target, [move]);
      recordCompletedMigrationMoves(completed, target, [move]);
      updateMigrationManifestTarget(completed, target, [], { validationBeforeArchive: "passed" });
      completed.manifest.completedAt = completed.manifest.startedAt;
      writeSessionSqliteMigrationManifest(completed);
      using clock = vi.spyOn(performance, "now");
      clock.mockReturnValue(0);
      expect(collectRecoveryDiskUsage({ cfg: {}, env: state.env }).total.retirable.count).toBe(1);
      const unfinished = createSessionSqliteMigrationRun(state.env, [target]);
      recordPlannedMigrationMoves(unfinished, target, [move]);
      fs.appendFileSync(unfinished.manifestPath, " ".repeat(3 * 1024 * 1024));
      const usage = collectRecoveryDiskUsage({ cfg: {}, env: state.env });
      expect(usage).toMatchObject({
        incomplete: true,
        incompleteReasons: expect.arrayContaining(["metadata-byte-limit"]),
        total: {
          logicalBytes: 8,
          count: 1,
          retirable: { count: 0 },
          protected: { count: 1, logicalBytes: 8 },
        },
      });
      expect(fs.readFileSync(archivePath, "utf8")).toBe("original");
    },
  );
});
