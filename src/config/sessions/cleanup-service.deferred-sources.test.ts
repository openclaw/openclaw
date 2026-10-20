import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { planSessionJsonlArchiveMove } from "../../commands/doctor-session-sqlite-archive.js";
import { recordDeferredPluginSessionImport } from "../../infra/deferred-plugin-session-sources.js";
import { readMigrationArtifactIdentity } from "../../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordPlannedMigrationMoves,
} from "../../infra/session-sqlite-migration-manifest.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { replaceSessionEntrySync } from "./session-accessor.entry.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

vi.mock("./store-maintenance-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store-maintenance-runtime.js")>()),
  resolveMaintenanceConfig: () => ({
    mode: "enforce" as const,
    pruneAfterMs: 24 * 60 * 60 * 1000,
    archiveDashboardAfterMs: null,
    maxEntries: 5000,
    modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
    preserveRecentMs: null,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
  }),
}));

it("preserves receipt and manifest sources without canonical entries during enforced cleanup", async () => {
  await withOpenClawTestState({ label: "cleanup-deferred-sources" }, async (state) => {
    const sessionPath = (name: string) => path.join(state.sessionsDir("main"), name);
    const storePath = sessionPath("sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:current", storePath },
      { sessionId: "current", updatedAt: Date.now() },
    );
    fs.writeFileSync(storePath, "{}");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const writeOld = (name: string, data: string) => {
      const file = sessionPath(name);
      fs.writeFileSync(file, data);
      fs.utimesSync(file, old, old);
      return file;
    };
    const sourceBytes = '{"type":"message","message":{"role":"user","content":"retained"}}\n';
    const sourcePath = writeOld("retained.jsonl", sourceBytes);
    const pointerPath = writeOld(
      "retained.trajectory-path.json",
      '{"runtimeFile":"archived.trajectory.jsonl"}',
    );
    const orphanPath = writeOld("orphan.jsonl", "unreferenced");
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }).path;
    recordDeferredPluginSessionImport({
      cfg: {},
      target,
      sqlitePath,
      env: state.env,
      pluginIds: ["codex"],
      sources: [storePath, sourcePath, pointerPath].map((file) => ({
        path: file,
        identity: readMigrationArtifactIdentity(file),
      })),
      recordCount: 0,
    });
    const migrationTarget = { ...target, sqlitePath };
    const run = createSessionSqliteMigrationRun(state.env, [migrationTarget]);
    const pendingPath = writeOld("pending.jsonl", "manifest source");
    const dependencyPath = writeOld("pending.trajectory-path.json", "manifest source");
    const disposedPath = writeOld("disposed.jsonl", "manifest source");
    recordPlannedMigrationMoves(
      run,
      migrationTarget,
      [pendingPath, disposedPath].map((file) => {
        const move = planSessionJsonlArchiveMove({
          archiveKey: path.basename(file),
          kind: "transcript",
          sourcePathRaw: file,
          target,
        });
        move.artifact = {
          identity: readMigrationArtifactIdentity(file),
          classification: "protected",
          reason: "Deferred plugin still requires the original",
          dependencies: file === pendingPath ? [dependencyPath] : [],
          disposal:
            file === pendingPath
              ? { state: "retained" }
              : { state: "disposed", disposedAt: new Date().toISOString() },
        };
        return move;
      }),
    );

    const cleanup = (dryRun = false) =>
      runSessionsCleanup({
        cfg: {},
        opts: { dryRun, enforce: true },
        targets: [target],
      });
    const preview = await cleanup(true);
    expect(preview.previewResults[0]?.summary.unreferencedArtifacts.removedFiles).toBe(2);
    const applied = await cleanup();
    expect(applied.appliedSummaries[0]?.unreferencedArtifacts.removedFiles).toBe(2);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBytes);
    expect(
      [pointerPath, pendingPath, dependencyPath, orphanPath, disposedPath].map(fs.existsSync),
    ).toEqual([true, true, true, false, false]);
  });
});
