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
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:current", storePath },
      { sessionId: "current", updatedAt: Date.now() },
    );
    fs.writeFileSync(storePath, "{}");
    const sourcePath = path.join(path.dirname(storePath), "retained.jsonl");
    const pointerPath = path.join(path.dirname(storePath), "retained.trajectory-path.json");
    const orphanPath = path.join(path.dirname(storePath), "orphan.jsonl");
    const sourceBytes = '{"type":"message","message":{"role":"user","content":"retained"}}\n';
    fs.writeFileSync(sourcePath, sourceBytes);
    fs.writeFileSync(pointerPath, '{"runtimeFile":"archived.trajectory.jsonl"}');
    fs.writeFileSync(orphanPath, "unreferenced");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const file of [sourcePath, pointerPath, orphanPath]) {
      fs.utimesSync(file, old, old);
    }
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
    const pendingPath = path.join(path.dirname(storePath), "pending.jsonl");
    const dependencyPath = path.join(path.dirname(storePath), "pending.trajectory-path.json");
    const disposedPath = path.join(path.dirname(storePath), "disposed.jsonl");
    for (const file of [pendingPath, dependencyPath, disposedPath]) {
      fs.writeFileSync(file, "manifest source");
      fs.utimesSync(file, old, old);
    }
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

    const preview = await runSessionsCleanup({
      cfg: {},
      opts: { dryRun: true, enforce: true },
      targets: [target],
    });
    expect(preview.previewResults[0]?.summary.unreferencedArtifacts.removedFiles).toBe(2);
    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true },
      targets: [target],
    });
    expect(applied.appliedSummaries[0]?.unreferencedArtifacts.removedFiles).toBe(2);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe(sourceBytes);
    expect(fs.existsSync(pointerPath)).toBe(true);
    expect(fs.existsSync(pendingPath)).toBe(true);
    expect(fs.existsSync(dependencyPath)).toBe(true);
    expect(fs.existsSync(orphanPath)).toBe(false);
    expect(fs.existsSync(disposedPath)).toBe(false);
  });
});
