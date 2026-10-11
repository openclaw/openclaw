import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.js";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import {
  readDeferredPluginSessionImport,
  resolveVerifiedSessionSource,
  type SessionSourceVerification,
} from "../infra/deferred-plugin-session-sources.js";
import * as migrationArtifact from "../infra/session-sqlite-migration-artifact.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { ExitError } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionSqliteMigrationWarnings } from "./doctor-session-sqlite-warnings.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import {
  runDoctorSessionSqlite,
  settleRetainedDoctorSessionSources,
  type DoctorSessionSqliteReport,
} from "./doctor-session-sqlite.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";
import { withDoctorSqliteMaintenanceLock } from "./doctor-sqlite-maintenance-lock.js";
import { doctorCommand } from "./doctor.js";

afterEach(() => vi.restoreAllMocks());

describe("retained session source verification", () => {
  it("rebuilds a missing receipt index while protecting a changed source", async () => {
    await withOpenClawTestState({ label: "deferred-missing-index" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
        state,
        "default",
        "brave",
      );
      const run = () =>
        runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      expect((await run()).totals.importedEntries).toBe(2);
      const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      const deletedTranscript = path.join(path.dirname(storePath), "legacy-deleted.jsonl");
      fs.renameSync(storePath, `${storePath}.preserved`);
      fs.copyFileSync(transcript, `${transcript}.copy`);
      fs.renameSync(`${transcript}.copy`, transcript);

      fs.appendFileSync(transcript, "\n");

      const result = await run();
      expect(result.totals.importedEntries).toBe(0);
      expect(result.totals.validatedEntries).toBe(1);
      expect(result.totals.archivedTranscriptFiles).toBe(1);
      const issues = result.targets.flatMap((target) => target.issues);
      expect(issues).toContainEqual(
        expect.objectContaining({ code: "retained_plugin_source_index_rebuilt" }),
      );
      const conflicts = issues.filter((issue) => issue.code === "historical_transcript_deferred");
      expect(conflicts).toHaveLength(1);
      const receipt = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) =>
          db
            .prepare(
              "SELECT report_json FROM migration_sources WHERE migration_kind = 'deferred-plugin-session-import'",
            )
            .get(),
        { env: state.env },
      );
      const sources = JSON.parse(String(receipt?.report_json)).sources;
      expect(sources.map((source: { path: string }) => source.path)).not.toContain(storePath);
      expect(sources.map((source: { path: string }) => source.path)).toContain(transcript);
      expect(fs.existsSync(storePath)).toBe(false);
      expect(
        loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.sessionId,
      ).toBe("legacy-kept");
      expect((await run()).totals.importedEntries).toBe(0);
      await deleteSessionEntryLifecycle({
        ...scope,
        target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
        archiveTranscript: false,
        deleteTranscriptWithoutArchive: true,
      });
      await recordDeferredPluginMigrations({
        env: state.env,
        pending: [],
        resolvedPluginIds: ["brave"],
      });
      const settled = await run();
      expect(settled.totals.importedEntries).toBe(0);
      expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
      expect(fs.existsSync(transcript)).toBe(false);
      expect(fs.existsSync(deletedTranscript)).toBe(false);
      const inspected = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        mode: "inspect",
        store: storePath,
      });
      expect(inspected.targets.flatMap((target) => target.issues)).not.toContainEqual(
        expect.objectContaining({ code: "plugin_migration_source_retained" }),
      );
    });
  });

  it("preserves an empty-index receipt with unindexed history for an existing database", async () => {
    await withOpenClawTestState({ label: "deferred-empty-index" }, async (state) => {
      openOpenClawStateDatabase({ env: state.env });
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
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

      await recordDeferredPluginMigrations({
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
      expect(report.totals.importedEntries).toBe(1);
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
      for (const manifestPath of migrationRun.listSessionSqliteMigrationManifestPaths(state.env)) {
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
      ).toEqual(["plugin_migration_source_retained"]);
      expect(fs.existsSync(uncaptured)).toBe(false);
      expect(unexpected.targets[0]?.archivedTranscriptFiles).toHaveLength(1);
      expect(fs.readFileSync(unexpected.targets[0]!.archivedTranscriptFiles[0]!, "utf8")).toBe(
        bytes,
      );
    });
  });

  it.each(["none", "archived", "conflicting-archives", "live", "missing-index"] as const)(
    "settles plugin work after index-free canonical session repair (remaining history: %s)",
    async (history) => {
      await withOpenClawTestState(
        {
          label: "deferred-index-free",
          env: {
            OPENCLAW_SERVICE_REPAIR_POLICY: "external",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          },
        },
        async (state) => {
          openOpenClawStateDatabase({ env: state.env });
          const cfg: OpenClawConfig = {
            agents: {
              ownership: "explicit",
              defaults: { systemAgent: { agentId: "main" }, sessionStore: { agentId: "main" } },
              entries: { main: {}, ops: {} },
            },
            gateway: { mode: "local" },
          };
          const historyIds =
            history === "conflicting-archives" ? ["history", "other-history"] : ["history"];
          for (const agentId of ["main", "ops"]) {
            const directory = state.sessionsDir(agentId);
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, "sessions.json"), "{}");
            for (const historyId of historyIds) {
              fs.writeFileSync(
                path.join(directory, `${agentId}-${historyId}.jsonl`),
                [
                  { type: "session", version: 3, id: `${agentId}-${historyId}` },
                  {
                    type: "message",
                    id: `${agentId}-user`,
                    parentId: null,
                    message: { role: "user", content: "Canonical history" },
                  },
                ]
                  .map((entry) => JSON.stringify(entry))
                  .join("\n") + "\n",
              );
            }
          }
          const imported = await runDoctorSessionSqlite({
            cfg,
            env: state.env,
            allAgents: true,
            mode: "import",
          });
          expect(imported.totals.importedEntries).toBe(2 * historyIds.length);
          const manifest = migrationRun.readSessionSqliteMigrationManifest(
            imported.migrationRun!.manifestPath,
          )!;
          const originals = new Map<string, Buffer>();
          for (const target of manifest.targets) {
            expect(fs.existsSync(target.storePath)).toBe(false);
            for (const move of target.completedMoves) {
              originals.set(move.archivePath, fs.readFileSync(move.archivePath));
              if (
                (history === "live" || history === "missing-index") &&
                move.kind === "transcript"
              ) {
                fs.copyFileSync(move.archivePath, move.sourcePath);
              }
              if (history === "missing-index" && move.kind === "legacy-store") {
                fs.unlinkSync(move.archivePath);
                originals.delete(move.archivePath);
              }
            }
            if (history === "archived" || history === "conflicting-archives") {
              for (const move of [...target.plannedMoves, ...target.completedMoves]) {
                if (move.kind !== "transcript") {
                  continue;
                }
                // An older import retained primary history as a protected archive.
                move.kind = "unreferenced-jsonl";
                move.artifact!.classification = "protected";
                move.artifact!.reason = "unreferenced-history";
              }
            }
            if (history === "missing-index") {
              for (const move of [...target.plannedMoves, ...target.completedMoves]) {
                if (move.kind === "legacy-store") {
                  move.artifact!.classification = "protected";
                  move.artifact!.reason = "incomplete-index-import";
                }
              }
            }
          }
          fs.writeFileSync(imported.migrationRun!.manifestPath, JSON.stringify(manifest));
          if (history === "conflicting-archives") {
            const duplicate = structuredClone(manifest);
            duplicate.runId += "-duplicate";
            for (const target of duplicate.targets) {
              target.plannedMoves = target.plannedMoves.filter(
                (move) => move.kind === "unreferenced-jsonl",
              );
              for (const move of target.plannedMoves) {
                const bytes = Buffer.from(
                  originals
                    .get(move.archivePath)!
                    .toString("utf8")
                    .replace("Canonical history", "Conflicting history"),
                );
                move.archivePath += ".duplicate";
                fs.writeFileSync(move.archivePath, bytes);
                move.artifact!.identity = migrationArtifact.readMigrationArtifactIdentity(
                  move.archivePath,
                );
                originals.set(move.archivePath, bytes);
              }
              target.completedMoves = structuredClone(target.plannedMoves);
            }
            fs.writeFileSync(
              path.join(
                path.dirname(imported.migrationRun!.manifestPath),
                `${duplicate.runId}.json`,
              ),
              JSON.stringify(duplicate),
            );
          }
          const pluginId = "session-fixture";
          const pluginRoot = state.path("session-plugin");
          fs.mkdirSync(pluginRoot);
          fs.writeFileSync(
            path.join(pluginRoot, "package.json"),
            JSON.stringify({
              name: "@example/session-fixture",
              version: "1.0.0",
              openclaw: { extensions: ["./index.cjs"] },
            }),
          );
          fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
          fs.writeFileSync(
            path.join(pluginRoot, "openclaw.plugin.json"),
            JSON.stringify({
              id: pluginId,
              configSchema: {
                type: "object",
                properties: { fixture: { type: "boolean" } },
                additionalProperties: false,
              },
              doctorContract: {
                stateMigrations: [
                  { id: "session-state", phase: "after-session-repair", doctorOnly: true },
                ],
              },
            }),
          );
          fs.writeFileSync(
            path.join(pluginRoot, "doctor-contract-api.cjs"),
            `module.exports = { stateMigrations: [{ id: "session-state", label: "Synthetic session state", phase: "after-session-repair", doctorOnly: true, detectLegacyState: () => null, migrateLegacyState: () => { throw new Error("No plugin inputs exist"); } }] };\n`,
          );
          cfg.plugins = {
            allow: [pluginId],
            load: { paths: [pluginRoot] },
            entries: { [pluginId]: { enabled: true, config: { fixture: true } } },
          };
          await state.writeConfig(cfg);
          await recordDeferredPluginMigrations({
            env: state.env,
            pending: [
              {
                pluginId,
                reason: "Retained session migration has not completed.",
                command: "openclaw doctor --fix",
                requiresStateMigration: true,
                configPaths: [["plugins", "entries", pluginId, "config"]],
              },
            ],
          });
          const io = createConfigIO({ env: state.env, configPath: state.configPath });
          const editConfig = async () => {
            const snapshot = await io.readConfigFileSnapshot();
            await io.writeConfigFile(
              {
                ...snapshot.sourceConfig,
                plugins: {
                  ...snapshot.sourceConfig.plugins,
                  entries: { [pluginId]: { enabled: true, config: { fixture: false } } },
                },
              },
              {
                explicitSetPaths: [["plugins", "entries", pluginId, "config", "fixture"]],
                skipRuntimeSnapshotRefresh: true,
              },
            );
          };
          await expect(editConfig()).rejects.toThrow("Cannot edit retained config");
          const repair = noteSessionTranscriptHealth({ cfg, env: state.env, shouldRepair: true });
          await repair;
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
          const row = withExistingOpenClawStateDatabaseReadOnly(
            ({ db }) =>
              db
                .prepare("SELECT status, finished_at FROM migration_runs WHERE id = ?")
                .get(`deferred-plugin-migration:${pluginId}`),
            { env: state.env },
          );
          expect(row?.status).toBe("completed");
          expect(row?.finished_at).not.toBeNull();
          if (history === "conflicting-archives") {
            const warnings = readSessionSqliteMigrationWarnings(state.env);
            expect(warnings).toHaveLength(4);
            for (const agentId of ["main", "ops"]) {
              for (const historyId of historyIds) {
                expect(warnings).toContainEqual(
                  expect.stringContaining(
                    `${agentId}-${historyId}: multiple primary files claim this identity`,
                  ),
                );
              }
            }
          }
          await editConfig();
          expect(
            (await io.readConfigFileSnapshot()).sourceConfig.plugins?.entries?.[pluginId]?.config,
          ).toEqual({ fixture: false });
          for (const [file, bytes] of originals) {
            expect(fs.readFileSync(file)).toEqual(bytes);
          }
          if (history === "missing-index" || history === "live") {
            for (const target of manifest.targets) {
              expect(fs.existsSync(target.storePath)).toBe(false);
              for (const move of target.completedMoves) {
                if (move.kind === "transcript") {
                  if (history === "missing-index") {
                    expect(fs.readFileSync(move.sourcePath)).toEqual(
                      originals.get(move.archivePath),
                    );
                  } else {
                    expect(fs.existsSync(move.sourcePath)).toBe(false);
                    const settledMoves = migrationRun
                      .listSessionSqliteMigrationManifestPaths(state.env)
                      .flatMap(
                        (file) =>
                          migrationRun.readSessionSqliteMigrationManifest(file)?.targets ?? [],
                      )
                      .flatMap((owner) => owner.completedMoves)
                      .filter(
                        (settled) =>
                          settled.sourcePath === move.sourcePath &&
                          settled.archivePath !== move.archivePath,
                      );
                    expect(settledMoves).toHaveLength(1);
                    expect(settledMoves[0]!.artifact).toMatchObject({
                      classification: "protected",
                      reason: "indexed-historical-primary",
                      disposal: { state: "retained" },
                    });
                    expect(fs.readFileSync(settledMoves[0]!.archivePath)).toEqual(
                      originals.get(move.archivePath),
                    );
                  }
                }
              }
            }
          }
        },
      );
    },
  );

  it("reads each archive manifest once when verifying 32 retained transcripts", async () => {
    await withOpenClawTestState({ label: "deferred-plugin-manifest-reads" }, async (state) => {
      const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state);
      const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
      for (let index = 2; index < 32; index++) {
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
      expect((await run()).totals.importedEntries).toBe(32);
      await recordDeferredPluginMigrations({
        env: state.env,
        pending: [],
        resolvedPluginIds: ["fixture-plugin"],
      });
      const archived = await run();
      expect(archived.totals.importedEntries).toBe(0);
      expect(archived.totals.archivedTranscriptFiles).toBe(32);
      expect(fs.existsSync(storePath)).toBe(false);
      // Older releases left this receipt active even after its originals were archived.
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          db.prepare(
            "UPDATE migration_sources SET removed_source = 0 WHERE migration_kind = 'deferred-plugin-session-import'",
          ).run();
        },
        { env: state.env },
      );
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
        expect(read()?.sources).toHaveLength(32 + 1);
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
        expect(validated.totals.validatedEntries).toBe(32);
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
      expect(read()?.sources).toHaveLength(32 + 1);
      fs.appendFileSync(transcriptMove.archivePath, "\n");
      expect(read).toThrow("Retained session migration source changed");
    });
  });
  it("settles verified retained sources when a historical transcript stays deferred", async () => {
    await withOpenClawTestState({ label: "deferred-historical-settlement" }, async (state) => {
      const { cfg, storePath, originals } = await seedDeferredPluginSessionSource(
        state,
        "default",
        "codex",
      );
      const directory = path.dirname(storePath);
      const bootTranscript = path.join(directory, "boot-2026-06-12_01-38-43-539-a2a5aeed.jsonl");
      const bootBytes = Buffer.from(
        [
          { type: "session", version: 3, id: "legacy-boot" },
          {
            type: "message",
            id: "boot-message",
            parentId: null,
            message: { role: "user", content: "boot" },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      fs.writeFileSync(bootTranscript, bootBytes);
      const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
      entries["agent:main:boot"] = {
        sessionId: "legacy-boot",
        sessionFile: path.basename(bootTranscript),
        updatedAt: 20,
      };
      fs.writeFileSync(storePath, JSON.stringify(entries));
      const run = () =>
        runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      expect((await run()).targets.flatMap((target) => target.issues)).toEqual([
        expect.objectContaining({ code: "plugin_migration_source_retained" }),
      ]);
      fs.renameSync(storePath, `${storePath}.preserved`);
      await withDoctorSqliteMaintenanceLock({
        env: state.env,
        operation: "settle retained codex sources",
        run: async (authority) => {
          const report = await run();
          await expect(
            settleRetainedDoctorSessionSources(report, ["codex"], authority, () =>
              authority.assertCurrent(),
            ),
          ).resolves.toBeUndefined();
          expect(report.targets.flatMap((target) => target.issues)).toEqual([
            expect.objectContaining({ code: "retained_plugin_source_index_rebuilt" }),
            {
              code: "historical_transcript_deferred",
              message: `${bootTranscript}: Error: Primary transcript header does not match its original filename`,
            },
          ]);
        },
      });
      const moves = migrationRun
        .listSessionSqliteMigrationManifestPaths(state.env)
        .flatMap((file) => migrationRun.readSessionSqliteMigrationManifest(file)?.targets ?? [])
        .flatMap((owner) => owner.completedMoves);
      for (const transcript of ["legacy-kept.jsonl", "legacy-deleted.jsonl"]) {
        const sourcePath = path.join(directory, transcript);
        expect(fs.existsSync(sourcePath)).toBe(false);
        const move = moves.find((candidate) => candidate.sourcePath === sourcePath);
        expect(move?.artifact).toMatchObject({
          classification: "protected",
          reason: "indexed-historical-primary",
        });
        expect(fs.readFileSync(move!.archivePath)).toEqual(originals.get(sourcePath));
      }
      const bootMoves = moves.filter((candidate) => candidate.sourcePath === bootTranscript);
      expect(bootMoves).toHaveLength(1);
      expect(bootMoves[0]!.artifact).toMatchObject({
        classification: "protected",
        reason: "unreferenced-history",
        disposal: { state: "retained" },
      });
      expect(fs.readFileSync(bootMoves[0]!.archivePath)).toEqual(bootBytes);
      await recordDeferredPluginMigrations({
        env: state.env,
        pending: [],
        resolvedPluginIds: ["codex"],
      });
      const rerun = await run();
      expect(rerun.targets.flatMap((target) => target.issues)).toEqual([
        {
          code: "historical_transcript_deferred",
          message: `${bootTranscript}: Error: Primary transcript header does not match its original filename`,
        },
      ]);
      expect(fs.readFileSync(bootMoves[0]!.archivePath)).toEqual(bootBytes);
    });
  });
});
