import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { readDeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import { readSessionSqliteMigrationManifest } from "../infra/session-sqlite-migration-manifest.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { countBlockingSessionSqliteIssues } from "./doctor-session-sqlite-types.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

it("receipts indexless configured history and archives retired history while a plugin is pending", async () => {
  await withOpenClawTestState({ label: "indexless-deferred-fleet" }, async (state) => {
    const { cfg, storePath } = await seedDeferredPluginSessionSource(state, "default", "codex");
    cfg.agents = { entries: { main: {}, active: {} } };
    const originalIndex = fs.readFileSync(storePath);
    const sources = new Map<string, string>();
    for (const agentId of ["active", "retired", "trajectory-only"]) {
      const directory = state.sessionsDir(agentId);
      fs.mkdirSync(directory, { recursive: true });
      const bytes =
        [
          {
            type: "session",
            version: 3,
            id: `${agentId}-history`,
            timestamp: "2026-07-01T00:00:00.000Z",
          },
          {
            type: "message",
            id: `${agentId}-message`,
            parentId: null,
            message: { role: "user", content: `Preserve ${agentId} history` },
          },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n";
      const source = path.join(
        directory,
        `${agentId}-history${agentId === "trajectory-only" ? ".trajectory" : ""}.jsonl`,
      );
      fs.writeFileSync(source, bytes);
      sources.set(source, bytes);
    }
    const options = { cfg, env: state.env, mode: "import" as const, allAgents: true };
    const report = await runDoctorSessionSqlite(options);
    expect(report.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0)).toBe(
      true,
    );
    expect(fs.readFileSync(storePath)).toEqual(originalIndex);
    const active = report.targets.find((target) => target.agentId === "active")!;
    expect(active.issues).toContainEqual(
      expect.objectContaining({ code: "retained_plugin_source_index_rebuilt" }),
    );
    const receipt = readDeferredPluginSessionImport({
      cfg,
      env: state.env,
      target: active,
      sqlitePath: active.sqlitePath,
    });
    expect(receipt?.sources.map((source) => source.path)).toEqual([
      path.join(state.sessionsDir("active"), "active-history.jsonl"),
    ]);
    expect(fs.existsSync(active.storePath)).toBe(false);
    const activeScope = {
      agentId: "active",
      env: state.env,
      storePath: active.storePath,
      sessionId: "active-history",
      sessionKey: "agent:active:recovered:active-history",
    };
    expect(loadExactSessionEntry(activeScope)?.entry.sessionId).toBe("active-history");
    const events = loadTranscriptEventsSync(activeScope);
    expect(events).toHaveLength(2);
    const manifest = readSessionSqliteMigrationManifest(report.migrationRun!.manifestPath)!;
    for (const agentId of ["retired", "trajectory-only"]) {
      const target = manifest.targets.find((candidate) => candidate.agentId === agentId)!;
      expect(target.completedMoves).toHaveLength(1);
      const move = target.completedMoves[0]!;
      expect(move.artifact).toMatchObject({
        classification: "protected",
        disposal: { state: "retained" },
      });
      expect(fs.existsSync(move.sourcePath)).toBe(false);
      expect(fs.readFileSync(move.archivePath, "utf8")).toBe(sources.get(move.sourcePath));
      expect(fs.existsSync(target.storePath)).toBe(false);
    }
    expect(
      fs.existsSync(
        resolveTargetSqlitePath(
          {
            agentId: "trajectory-only",
            storePath: path.join(state.sessionsDir("trajectory-only"), "sessions.json"),
          },
          state.env,
        ),
      ),
    ).toBe(false);
    expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    const newIndex = JSON.stringify({
      "agent:active:unimported": { sessionId: "unimported", updatedAt: 999 },
    });
    fs.writeFileSync(active.storePath, newIndex);
    const retried = await runDoctorSessionSqlite(options);
    expect(retried.totals.importedEntries).toBe(0);
    expect(
      loadExactSessionEntry({ ...activeScope, sessionKey: "agent:active:unimported" }),
    ).toBeUndefined();
    const conflictingIndex = readSessionSqliteMigrationManifest(retried.migrationRun!.manifestPath)!
      .targets.find((target) => target.agentId === "active")!
      .completedMoves.find((move) => move.kind === "legacy-store")!;
    expect(conflictingIndex.artifact?.classification).toBe("protected");
    expect(fs.readFileSync(conflictingIndex.archivePath, "utf8")).toBe(newIndex);
    expect(loadTranscriptEventsSync(activeScope)).toEqual(events);
    await recordDeferredPluginMigrations({
      env: state.env,
      pending: [],
      resolvedPluginIds: ["codex"],
    });
    const settled = await runDoctorSessionSqlite(options);
    const activeArchive = settled.targets.find(
      (target) => target.agentId === "active",
    )!.archivedTranscriptFiles;
    expect(activeArchive).toHaveLength(1);
    expect(fs.readFileSync(activeArchive[0]!, "utf8")).toBe(
      sources.get(path.join(state.sessionsDir("active"), "active-history.jsonl")),
    );
    expect(loadTranscriptEventsSync(activeScope)).toEqual(events);
    expect(fs.existsSync(storePath)).toBe(false);
  });
});
