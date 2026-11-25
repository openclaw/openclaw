import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import {
  findLatestFailedSessionSqliteMigrationManifest as findFailedRun,
  listSessionSqliteMigrationManifestPaths as listManifests,
  readSessionSqliteMigrationManifest as readManifest,
} from "../infra/session-sqlite-migration-manifest.js";
import { ExitError } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionSqliteMigrationWarnings } from "./doctor-session-sqlite-warnings.js";
import {
  addDeferredPluginSessions,
  seedDeferredPluginSessionSource,
} from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { jsonl, messageEvent, writeJson } from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import {
  containsObjects,
  expectFiles,
  expectMissing,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import { stateRows, writeState } from "./doctor-session-sqlite.test-support.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";
import { doctorCommand } from "./doctor.js";

afterEach(() => vi.restoreAllMocks());

it("rebuilds a missing receipt index while protecting a changed source", async () => {
  await withOpenClawTestState({ label: "deferred-missing-index" }, async (state) => {
    const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(
      state,
      "default",
      "brave",
    );
    const run = sessionDoctor(cfg, state.env, storePath);
    expect((await run()).totals.importedEntries).toBe(2);
    const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
    const deletedTranscript = path.join(path.dirname(storePath), "legacy-deleted.jsonl");
    fs.renameSync(storePath, `${storePath}.preserved`);
    fs.copyFileSync(transcript, `${transcript}.copy`);
    fs.renameSync(`${transcript}.copy`, transcript);

    fs.appendFileSync(transcript, "\n");

    const result = await run();
    expect(result.totals).toMatchObject({
      importedEntries: 0,
      validatedEntries: 1,
      archivedTranscriptFiles: 1,
    });
    const issues = allIssues(result);
    containsObjects(issues, { code: "retained_plugin_source_index_rebuilt" });
    const conflicts = issues.filter((issue) => issue.code === "historical_transcript_deferred");
    expect(conflicts).toHaveLength(1);
    const receipt = stateRows(
      state.env,
      "SELECT report_json FROM migration_sources WHERE migration_kind = 'deferred-plugin-session-import'",
    )?.[0];
    const sources = JSON.parse(String(receipt?.report_json)).sources;
    expect(sources.map((source: { path: string }) => source.path)).not.toContain(storePath);
    expect(sources.map((source: { path: string }) => source.path)).toContain(transcript);
    expectMissing(storePath);
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
    expectMissing(transcript, deletedTranscript);
    const inspected = await run("inspect");
    expect(allIssues(inspected)).not.toContainEqual(
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

    writeTranscript(
      path.join(directory, "historical.jsonl"),
      "historical",
      "message",
      "Retained history",
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
    const run = sessionDoctor(cfg, state.env, storePath);
    const report = await run();
    expect(report.totals.importedEntries).toBe(1);
    expectIssueCodes(report, "plugin_migration_source_retained");
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
      expectIssueCodes(retried, "plugin_migration_source_retained");
    }
    for (const manifestPath of listManifests(state.env)) {
      const manifest = readManifest(manifestPath);
      expect(manifest?.completedAt).toBeDefined();
      expect(manifest?.failedAt).toBeUndefined();
      expect(manifest?.failureReports).toBeUndefined();
    }
    expect(findFailedRun(state.env, report.targets)).toBeUndefined();
    expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
    expect(
      loadExactSessionEntry({ ...scope, sessionKey: "agent:main:current" })?.entry.sessionId,
    ).toBe("current");
    expectFiles("{}", storePath);

    const uncaptured = path.join(directory, "current.jsonl");
    const bytes = JSON.stringify({ type: "session", version: 3, id: "current" }) + "\n";
    fs.writeFileSync(uncaptured, bytes);
    const unexpected = await run();
    expectIssueCodes(unexpected, "plugin_migration_source_retained");
    expectMissing(uncaptured);
    expect(unexpected.targets[0]?.archivedTranscriptFiles).toHaveLength(1);
    expectFiles(bytes, unexpected.targets[0]!.archivedTranscriptFiles[0]!);
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
            writeTranscript(
              path.join(directory, `${agentId}-${historyId}.jsonl`),
              `${agentId}-${historyId}`,
              `${agentId}-user`,
              "Canonical history",
            );
          }
        }
        const imported = await sessionDoctor(cfg, state.env)();
        expect(imported.totals.importedEntries).toBe(2 * historyIds.length);
        const manifestPath = imported.migrationRun!.manifestPath;
        const manifest = readManifest(manifestPath)!;
        const originals = new Map<string, Buffer>();
        for (const target of manifest.targets) {
          expectMissing(target.storePath);
          for (const move of target.completedMoves) {
            originals.set(move.archivePath, fs.readFileSync(move.archivePath));
            if ((history === "live" || history === "missing-index") && move.kind === "transcript") {
              fs.copyFileSync(move.archivePath, move.sourcePath);
            }
            if (history === "missing-index" && move.kind === "legacy-store") {
              fs.unlinkSync(move.archivePath);
              originals.delete(move.archivePath);
            }
          }
          for (const move of [...target.plannedMoves, ...target.completedMoves]) {
            if (
              (history === "archived" || history === "conflicting-archives") &&
              move.kind === "transcript"
            ) {
              // An older import retained primary history as a protected archive.
              move.kind = "unreferenced-jsonl";
              move.artifact!.classification = "protected";
              move.artifact!.reason = "unreferenced-history";
            }
            if (history === "missing-index" && move.kind === "legacy-store") {
              move.artifact!.classification = "protected";
              move.artifact!.reason = "incomplete-index-import";
            }
          }
        }
        writeJson(manifestPath, manifest);
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
          writeJson(path.join(path.dirname(manifestPath), `${duplicate.runId}.json`), duplicate);
        }
        const pluginId = "session-fixture";
        const pluginRoot = state.path("session-plugin");
        fs.mkdirSync(pluginRoot);
        writeJson(path.join(pluginRoot, "package.json"), {
          name: "@example/session-fixture",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        });
        fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
        writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
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
        });
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
        const editConfig = async () => {
          const io = createConfigIO({
            env: state.env,
            configPath: state.configPath,
            deferredPluginMigrations: readDeferredPluginMigrations({ env: state.env }),
          });
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
        await noteSessionTranscriptHealth({ cfg, env: state.env, shouldRepair: true });
        expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
        const row = stateRows(
          state.env,
          `SELECT status, finished_at FROM migration_runs WHERE id = 'deferred-plugin-migration:${pluginId}'`,
        )?.[0];
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
          (await createConfigIO({ env: state.env }).readConfigFileSnapshot()).sourceConfig.plugins
            ?.entries?.[pluginId]?.config,
        ).toEqual({ fixture: false });
        for (const [file, bytes] of originals) {
          expectFiles(bytes, file);
        }
        if (history === "missing-index" || history === "live") {
          const completedMoves = listManifests(state.env)
            .flatMap((file) => readManifest(file)?.targets ?? [])
            .flatMap((owner) => owner.completedMoves);
          for (const target of manifest.targets) {
            expectMissing(target.storePath);
            for (const move of target.completedMoves) {
              if (move.kind !== "transcript") {
                continue;
              }
              if (history === "missing-index") {
                expect(fs.readFileSync(move.sourcePath)).toEqual(originals.get(move.archivePath));
              } else {
                expectMissing(move.sourcePath);
                const settledMoves = completedMoves.filter(
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
      },
    );
  },
);

it("reads each archive manifest once when verifying 32 retained transcripts", async () => {
  await withOpenClawTestState({ label: "deferred-plugin-manifest-reads" }, async (state) => {
    const { cfg, storePath, scope } = await seedDeferredPluginSessionSource(state);
    addDeferredPluginSessions(storePath, 32);
    const run = sessionDoctor(cfg, state.env, storePath);
    expect((await run()).totals.importedEntries).toBe(32);
    await recordDeferredPluginMigrations({
      env: state.env,
      pending: [],
      resolvedPluginIds: ["fixture-plugin"],
    });
    const archived = await run();
    expect(archived.totals.importedEntries).toBe(0);
    expect(archived.totals.archivedTranscriptFiles).toBe(32);
    expectMissing(storePath);
    // Older releases left this receipt active even after its originals were archived.
    writeState(state.env, [
      "UPDATE migration_sources SET removed_source = 0 WHERE migration_kind = 'deferred-plugin-session-import'",
    ]);
    const manifestPaths = listManifests(state.env);
    const manifestPath = archived.migrationRun!.manifestPath;
    const manifestBytes = fs.readFileSync(manifestPath);
    const manifest = readManifest(manifestPath)!;
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
    const manifestsRead = () =>
      reads.mock.calls.flatMap(([file]) =>
        typeof file === "string" && manifestPaths.includes(file) ? [file] : [],
      );
    for (let pass = 0; pass < 2; pass++) {
      reads.mockClear();
      expect(read()?.sources).toHaveLength(32 + 1);
      const readPaths = manifestsRead();
      expect(readPaths.length).toBeGreaterThan(0);
      expect(readPaths.length).toBe(new Set(readPaths).size);
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
      const validated = await run("validate");
      expect(validated.totals.importedEntries).toBe(0);
      expect(validated.totals.validatedEntries).toBe(32);
      const verifiedArchives = hashes.mock.calls
        .map(([file]) => file)
        .filter((file) => transcriptArchives.includes(file));
      expect(verifiedArchives.toSorted()).toEqual(transcriptArchives.toSorted());
      const readPaths = manifestsRead();
      expect(readPaths.length).toBeGreaterThan(0);
      // History discovery and receipt verification each read one copy per run.
      for (const file of manifestPaths) {
        expect(readPaths.filter((readPath) => readPath === file)).toHaveLength(2);
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
    const resolveSource = (target = sourceTarget, sourceEnv = state.env) =>
      resolveVerifiedSessionSource(source, target, sourceEnv, verification);
    expect(resolveSource()).toBe(transcriptMove.archivePath);
    source.identity.sha256 = "0".repeat(64);
    expect(resolveSource()).toBeUndefined();
    source.identity = { ...transcriptMove.artifact!.identity };
    expect(resolveSource({ ...sourceTarget, agentId: "other" })).toBeUndefined();
    expect(
      resolveSource(sourceTarget, {
        ...state.env,
        OPENCLAW_STATE_DIR: state.statePath("other-state"),
      }),
    ).toBeUndefined();
    for (const target of manifest.targets) {
      target.plannedMoves = target.plannedMoves.filter(
        (move) => move.sourcePath !== transcriptMove.sourcePath,
      );
      target.completedMoves = target.completedMoves.filter(
        (move) => move.sourcePath !== transcriptMove.sourcePath,
      );
    }
    writeJson(manifestPath, manifest);
    expect(read).toThrow("Retained session migration source changed");
    fs.writeFileSync(manifestPath, manifestBytes);
    expect(read()?.sources).toHaveLength(32 + 1);
    fs.appendFileSync(transcriptMove.archivePath, "\n");
    expect(read).toThrow("Retained session migration source changed");
  });
});

function allIssues(report: DoctorSessionSqliteReport) {
  return report.targets.flatMap((target) => target.issues);
}

function expectIssueCodes(report: DoctorSessionSqliteReport, ...codes: string[]) {
  expect(allIssues(report).map((issue) => issue.code)).toEqual(codes);
}

function writeTranscript(file: string, sessionId: string, messageId: string, content: string) {
  fs.writeFileSync(
    file,
    jsonl({ type: "session", version: 3, id: sessionId }, messageEvent(messageId, "user", content)),
  );
}

function sessionDoctor(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, store?: string) {
  return (mode: "import" | "inspect" | "validate" = "import") =>
    runDoctorSessionSqlite({
      cfg,
      env,
      mode,
      ...(mode === "import" ? { allAgents: true } : { store }),
    });
}
