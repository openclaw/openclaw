import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.sqlite-lifecycle.js";
import {
  createSessionSqliteMigrationRun,
  readSessionSqliteMigrationManifest,
  recordCompletedMigrationMoves,
  recordPlannedMigrationMoves,
  updateMigrationManifestTarget,
  writeSessionSqliteMigrationManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import {
  hasRetainedDoctorSessionSources,
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
} from "./doctor-session-sqlite.js";
import { retainedHistoryMove } from "./doctor-session-sqlite.recovery-fixtures.test-support.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";

it("settles plugin repair after a deleted session archive is removed", async () => {
  await withOpenClawTestState({ label: "missing-history-settlement" }, async (state) => {
    const { cfg, scope, storePath } = await seedDeferredPluginSessionSource(state, "default");
    const run = () =>
      runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
    await run();
    const deletion = await deleteSessionEntryLifecycle({
      ...scope,
      target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
      archiveTranscript: true,
    });
    expect(deletion.deleted).toBe(true);
    expect(deletion.archivedTranscripts).toHaveLength(1);
    const archive = deletion.archivedTranscripts[0]!.archivedPath;
    expect(path.basename(archive)).toMatch(/\.jsonl\.deleted\..+\.zst$/);
    fs.unlinkSync(archive);
    await withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "settle missing historical archive",
      run: async (authority) => {
        const report = await run();
        expect(hasRetainedDoctorSessionSources(report)).toBe(true);
        await settleRetainedDoctorSessionSources(report, ["fixture-plugin"], authority, () =>
          authority.assertCurrent(),
        );
        expect(report.targets.flatMap((target) => target.issues)).not.toContainEqual(
          expect.objectContaining({ code: "retained_plugin_source_settlement_failed" }),
        );
      },
    });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
    expect(fs.existsSync(archive)).toBe(false);
  });
});

it("settles plugin repair with a warning when an older retained original is gone", async () => {
  await withOpenClawTestState({ label: "missing-import-original" }, async (state) => {
    const { cfg, storePath } = await seedDeferredPluginSessionSource(state, "default");
    const run = () =>
      runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
    const imported = await run();
    const target = imported.targets[0]!;
    const prior = createSessionSqliteMigrationRun(state.env, [target]);
    const directory = path.join(
      path.dirname(path.dirname(storePath)),
      "session-sqlite-import-archive",
    );
    fs.mkdirSync(directory, { recursive: true });
    const bytes = '{"type":"session","version":3,"id":"history"}\n';
    const originals = [1, 2].map((generation) => {
      const archivePath = path.join(directory, `archive-tier.history.jsonl.imported-${generation}`);
      fs.writeFileSync(archivePath, bytes);
      const move = retainedHistoryMove(
        path.join(path.dirname(storePath), "history.jsonl"),
        archivePath,
      );
      recordPlannedMigrationMoves(prior, target, [move]);
      recordCompletedMigrationMoves(prior, target, [move]);
      return archivePath;
    });
    updateMigrationManifestTarget(prior, target, [], { validationBeforeArchive: "passed" });
    prior.manifest.completedAt = prior.manifest.startedAt;
    writeSessionSqliteMigrationManifest(prior);
    fs.unlinkSync(originals[0]!);

    await withDoctorSqliteMaintenanceLock({
      env: state.env,
      operation: "settle missing import original",
      run: async (authority) => {
        const report = await run();
        expect(hasRetainedDoctorSessionSources(report)).toBe(true);
        expect(fs.existsSync(storePath)).toBe(true);
        await settleRetainedDoctorSessionSources(report, ["fixture-plugin"], authority, () =>
          authority.assertCurrent(),
        );
        expect(report.targets.flatMap((owner) => owner.issues)).toContainEqual({
          code: "historical_transcript_deferred",
          message: expect.stringContaining("artifact is unexpectedly missing"),
        });
        expect(
          readSessionSqliteMigrationManifest(report.migrationRun!.manifestPath)?.failedAt,
        ).toBeUndefined();
      },
    });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.existsSync(originals[0]!)).toBe(false);
    expect(fs.readFileSync(originals[1]!, "utf8")).toBe(bytes);
    expect(
      readSessionSqliteMigrationManifest(prior.manifestPath)?.targets[0]?.completedMoves,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          archivePath: originals[0],
          artifact: expect.objectContaining({ disposal: { state: "retained" } }),
        }),
      ]),
    );
  });
});
