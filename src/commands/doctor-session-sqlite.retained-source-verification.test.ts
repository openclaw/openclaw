import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import {
  readDeferredPluginSessionImport,
  resolveVerifiedSessionSource,
  type SessionSourceVerification,
} from "../infra/deferred-plugin-session-sources.js";
import { ExitError } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as migrationArtifact from "./doctor-session-sqlite-artifact.js";
import * as migrationRun from "./doctor-session-sqlite-migration-run.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import { doctorCommand } from "./doctor.js";

afterEach(() => vi.restoreAllMocks());

describe("retained session source verification", () => {
  it.each([false, true])(
    "preserves an empty-index receipt for an existing database (unindexed history: %s)",
    async (history) => {
      await withOpenClawTestState({ label: "deferred-empty-index" }, async (state) => {
        const cfg: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
        const directory = state.sessionsDir("main");
        fs.mkdirSync(directory, { recursive: true });
        const storePath = path.join(directory, "sessions.json");
        fs.writeFileSync(storePath, "{}");
        const scope = { agentId: "main", storePath, env: state.env };
        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:current" },
          { sessionId: "current", updatedAt: 1 },
        );
        closeOpenClawAgentDatabasesForTest();
        if (history) {
          fs.writeFileSync(
            path.join(directory, "historical.jsonl"),
            [
              { type: "session", version: 3, id: "historical" },
              {
                type: "message",
                id: "message",
                parentId: null,
                message: { role: "user", content: "Retained history" },
              },
            ]
              .map((entry) => JSON.stringify(entry))
              .join("\n") + "\n",
          );
        }
        recordDeferredPluginMigrations({
          env: state.env,
          pending: [
            {
              pluginId: "fixture-plugin",
              reason: "Plugin is unavailable.",
              command: "openclaw doctor --fix",
            },
          ],
        });
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
          "Legacy session store requires migration",
        );
        const report = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        expect(report.totals.importedEntries).toBe(history ? 1 : 0);
        expect(report.targets.flatMap((target) => target.issues)).toEqual([
          expect.objectContaining({ code: "plugin_migration_source_retained" }),
        ]);
        for (const mode of ["import", "inspect", "validate", "dry-run"] as const) {
          const runtime = {
            log: vi.fn(),
            error: vi.fn(),
            exit: (code: number): never => {
              throw new ExitError(code);
            },
          };
          await expect(
            doctorCommand(runtime, {
              sessionSqlite: mode,
              sessionSqliteStore: storePath,
              json: true,
            }),
          ).rejects.toMatchObject({ code: 0 });
          const retried = JSON.parse(
            String(runtime.log.mock.calls.at(-1)?.[0]),
          ) as DoctorSessionSqliteReport;
          expect(retried.totals.importedEntries).toBe(0);
          expect(retried.targets.flatMap((target) => target.issues)).toEqual([
            expect.objectContaining({ code: "plugin_migration_source_retained" }),
          ]);
        }
        for (const manifestPath of migrationRun.listSessionSqliteMigrationManifestPaths(
          state.env,
        )) {
          const manifest = migrationRun.readSessionSqliteMigrationManifest(manifestPath);
          expect(manifest?.completedAt).toBeDefined();
          expect(manifest?.failedAt).toBeUndefined();
          expect(manifest?.failureReports).toBeUndefined();
        }
        expect(
          migrationRun.findLatestFailedSessionSqliteMigrationManifest(state.env, report.targets),
        ).toBeUndefined();
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:current" })?.entry.sessionId,
        ).toBe("current");
        expect(fs.readFileSync(storePath, "utf8")).toBe("{}");
        if (history) {
          const uncaptured = path.join(directory, "current.jsonl");
          const bytes = JSON.stringify({ type: "session", version: 3, id: "current" }) + "\n";
          fs.writeFileSync(uncaptured, bytes);
          const unexpected = await runDoctorSessionSqlite({
            cfg,
            env: state.env,
            allAgents: true,
            mode: "import",
          });
          expect(
            unexpected.targets.flatMap((target) => target.issues).map((issue) => issue.code),
          ).toEqual(["plugin_migration_source_retained", "active_sqlite_transcript_jsonl"]);
          expect(fs.readFileSync(uncaptured, "utf8")).toBe(bytes);
        }
      });
    },
  );

  it.each([2, 32])(
    "reads each archive manifest once per verification of %s retained transcripts",
    async (transcriptCount) => {
      await withOpenClawTestState({ label: "deferred-plugin-manifest-reads" }, async (state) => {
        const { cfg, storePath, scope } = seedDeferredPluginSessionSource(state);
        const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
        for (let index = 2; index < transcriptCount; index++) {
          const sessionId = `legacy-volume-${index}`;
          const sessionFile = `${sessionId}.jsonl`;
          entries[`agent:main:volume-${index}`] = { sessionId, sessionFile, updatedAt: 20 };
          fs.writeFileSync(
            path.join(path.dirname(storePath), sessionFile),
            `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`,
          );
        }
        fs.writeFileSync(storePath, JSON.stringify(entries));
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        expect((await run()).totals.importedEntries).toBe(transcriptCount);
        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
        const archived = await run();
        expect(archived.totals.importedEntries).toBe(0);
        expect(archived.totals.archivedTranscriptFiles).toBe(transcriptCount);
        expect(fs.existsSync(storePath)).toBe(false);
        const manifestPaths = migrationRun.listSessionSqliteMigrationManifestPaths(state.env);
        const manifestPath = archived.migrationRun!.manifestPath;
        const manifestBytes = fs.readFileSync(manifestPath);
        const manifest = migrationRun.readSessionSqliteMigrationManifest(manifestPath)!;
        const transcriptMove = manifest.targets
          .flatMap((target) => target.plannedMoves)
          .find((move) => move.kind === "transcript")!;
        const read = () =>
          readDeferredPluginSessionImport({
            cfg,
            env: state.env,
            target: { agentId: "main", storePath },
            sqlitePath: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
          });
        const reads = vi.spyOn(fs, "readFileSync");
        for (let pass = 0; pass < 2; pass++) {
          reads.mockClear();
          expect(read()?.sources).toHaveLength(transcriptCount + 1);
          const manifestsRead = reads.mock.calls.flatMap(([file]) =>
            typeof file === "string" && manifestPaths.includes(file) ? [file] : [],
          );
          expect(manifestsRead.length).toBeGreaterThan(0);
          expect(manifestsRead.length).toBe(new Set(manifestsRead).size);
        }

        // A retained index can coexist with archived transcripts after interrupted archival.
        const moves = manifest.targets.flatMap((target) => target.plannedMoves);
        const indexMove = moves.find((move) => move.sourcePath === storePath)!;
        const transcriptArchives = moves
          .filter((move) => move.kind === "transcript")
          .map((move) => move.archivePath);
        fs.renameSync(indexMove.archivePath, storePath);
        const hashes = vi.spyOn(migrationArtifact, "readMigrationArtifactIdentity");
        for (let pass = 0; pass < 2; pass++) {
          reads.mockClear();
          hashes.mockClear();
          const validated = await runDoctorSessionSqlite({
            cfg,
            env: state.env,
            store: storePath,
            mode: "validate",
          });
          expect(validated.totals.importedEntries).toBe(0);
          expect(validated.totals.validatedEntries).toBe(transcriptCount);
          const verifiedArchives = hashes.mock.calls
            .map(([file]) => file)
            .filter((file) => transcriptArchives.includes(file));
          expect(verifiedArchives.toSorted()).toEqual(transcriptArchives.toSorted());
          const manifestsRead = reads.mock.calls.flatMap(([file]) =>
            typeof file === "string" && manifestPaths.includes(file) ? [file] : [],
          );
          expect(manifestsRead.length).toBeGreaterThan(0);
          // History discovery and receipt verification each read one copy per run.
          for (const file of manifestPaths) {
            expect(manifestsRead.filter((readPath) => readPath === file)).toHaveLength(2);
          }
        }
        hashes.mockRestore();
        fs.renameSync(storePath, indexMove.archivePath);
        reads.mockRestore();

        const source = {
          path: transcriptMove.sourcePath,
          identity: { ...transcriptMove.artifact!.identity },
        };
        const sourceTarget = {
          agentId: "main",
          storePath,
          sqlitePath: resolveSqliteTargetFromSessionStorePath(storePath, scope).path,
        };
        const verification: SessionSourceVerification = new Map();
        expect(resolveVerifiedSessionSource(source, sourceTarget, state.env, verification)).toBe(
          transcriptMove.archivePath,
        );
        source.identity.sha256 = "0".repeat(64);
        expect(
          resolveVerifiedSessionSource(source, sourceTarget, state.env, verification),
        ).toBeUndefined();
        source.identity = { ...transcriptMove.artifact!.identity };
        expect(
          resolveVerifiedSessionSource(
            source,
            { ...sourceTarget, agentId: "other" },
            state.env,
            verification,
          ),
        ).toBeUndefined();
        expect(
          resolveVerifiedSessionSource(
            source,
            sourceTarget,
            { ...state.env, OPENCLAW_STATE_DIR: state.statePath("other-state") },
            verification,
          ),
        ).toBeUndefined();

        for (const target of manifest.targets) {
          target.plannedMoves = target.plannedMoves.filter(
            (move) => move.sourcePath !== transcriptMove.sourcePath,
          );
          target.completedMoves = target.completedMoves.filter(
            (move) => move.sourcePath !== transcriptMove.sourcePath,
          );
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        expect(read).toThrow("Retained session migration source changed");
        fs.writeFileSync(manifestPath, manifestBytes);
        expect(read()?.sources).toHaveLength(transcriptCount + 1);
        fs.appendFileSync(transcriptMove.archivePath, "\n");
        expect(read).toThrow("Retained session migration source changed");
      });
    },
  );
});
