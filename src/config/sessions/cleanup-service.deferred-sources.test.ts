import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { planSessionJsonlArchiveMove } from "../../commands/doctor-session-sqlite-archive.js";
import { recordDeferredPluginSessionImport } from "../../infra/deferred-plugin-session-sources.js";
import { readMigrationArtifactIdentity as identify } from "../../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  recordPlannedMigrationMoves,
} from "../../infra/session-sqlite-migration-manifest.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import { runSessionsCleanup } from "./cleanup-service.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const policy = { pruneAfter: "1d", archiveDashboardAfter: false, maxDiskBytes: false } as const;
it("preserves receipt and manifest sources without canonical entries during enforced cleanup", async () => {
  await withOpenClawTestState({ label: "cleanup-deferred-sources" }, async (state) => {
    const cfg = { session: { maintenance: policy } };
    setRuntimeConfigSnapshot(cfg);
    const sessionPath = (name: string) => path.join(state.sessionsDir("main"), name);
    const storePath = sessionPath("sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const target = { agentId: "main", storePath };
    const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, target).path;
    openOpenClawAgentDatabase({ agentId: target.agentId, path: sqlitePath });
    fs.writeFileSync(storePath, "{}");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const writeOld = (name: string, data: string) => {
      const file = sessionPath(name);
      fs.writeFileSync(file, data);
      fs.utimesSync(file, old, old);
      return file;
    };
    const sourceBytes = '{"type":"message","message":{"role":"user","content":"retained"}}\n';
    const source = writeOld("retained.jsonl", sourceBytes);
    const pointer = writeOld("retained.trajectory-path.json", '{"runtimeFile":"x"}');
    const orphan = writeOld("orphan.jsonl", "unreferenced");
    const files = [storePath, source, pointer];
    recordDeferredPluginSessionImport({
      cfg,
      target,
      sqlitePath,
      env: state.env,
      pluginIds: ["codex"],
      sources: files.map((file) => ({ path: file, identity: identify(file) })),
      recordCount: 0,
    });
    const migrationTarget = { ...target, sqlitePath };
    const pending = writeOld("pending.jsonl", "manifest source");
    const dependency = writeOld("pending.trajectory-path.json", "manifest source");
    const disposed = writeOld("disposed.jsonl", "manifest source");
    recordPlannedMigrationMoves(
      createSessionSqliteMigrationRun(state.env, [migrationTarget]),
      migrationTarget,
      [pending, disposed].map((file) => {
        const move = planSessionJsonlArchiveMove({
          archiveKey: path.basename(file),
          kind: "transcript",
          sourcePathRaw: file,
          target,
        });
        move.artifact = {
          identity: identify(file),
          classification: "protected",
          reason: "Deferred plugin still requires the original",
          dependencies: file === pending ? [dependency] : [],
          disposal:
            file === pending
              ? { state: "retained" }
              : { state: "disposed", disposedAt: new Date().toISOString() },
        };
        return move;
      }),
    );

    const cleanup = (dryRun = false) =>
      runSessionsCleanup({ cfg, opts: { dryRun, enforce: true }, targets: [target] });
    const preview = await cleanup(true);
    expect(preview.previewResults[0]?.summary.unreferencedArtifacts.removedFiles).toBe(2);
    const applied = await cleanup();
    expect(applied.appliedSummaries[0]?.unreferencedArtifacts.removedFiles).toBe(2);
    expect(fs.readFileSync(source, "utf8")).toBe(sourceBytes);
    const artifacts = [pointer, pending, dependency, orphan, disposed];
    expect(artifacts.filter(fs.existsSync)).toEqual([pointer, pending, dependency]);
  });
});
