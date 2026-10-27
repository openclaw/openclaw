import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionStoreMigrationRequiredError } from "../config/sessions/migration-required.js";
import {
  loadExactSessionEntry as loadEntry,
  upsertSessionEntryCore as upsertEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { resolveSqliteTargetFromSessionStorePath as resolveTarget } from "../config/sessions/session-sqlite-target.js";
import { assertSessionStoreMigrationComplete as assertMigrated } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  readDeferredPluginMigrations as readPending,
  recordDeferredPluginMigrations as recordPending,
} from "../infra/deferred-plugin-migrations.js";
import * as durability from "../infra/directory-durability.js";
import { readMigrationArtifactIdentity as artifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import { isSessionSqliteMigrationWarning as isWarning } from "../infra/session-sqlite-migration-issues.js";
import * as migrationRun from "../infra/session-sqlite-migration-manifest.js";
import { autoMigrateLegacyState } from "../infra/state-migrations.doctor.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesForTest as closeAgentHandles,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest as closeStateHandles,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState as withState } from "../test-utils/openclaw-test-state.js";
import {
  editAndDeleteImportedSessions,
  seedConcurrentDeferredPluginMigration as seedConcurrent,
  seedDeferredPluginSessionSource as seedSource,
} from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { jsonl, messageEvent } from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite, type DoctorSessionSqliteReport } from "./doctor-session-sqlite.js";
import {
  containsObjects,
  expectFiles,
  expectMissing,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

const fixturePlugin = "fixture-plugin";
afterEach(() => vi.restoreAllMocks());

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value));
}
function writeTranscript(file: string, id: string) {
  fs.writeFileSync(
    file,
    jsonl({ type: "session", version: 3, id }, messageEvent("message", "user", id)),
  );
}
function reportIssues(report: DoctorSessionSqliteReport) {
  return report.targets.flatMap((target) => target.issues);
}
function expectIssue(report: DoctorSessionSqliteReport, code: string) {
  containsObjects(reportIssues(report), { code });
}
function expectImport(
  report: DoctorSessionSqliteReport,
  importedEntries: number,
  ...codes: string[]
) {
  expect(report.totals.importedEntries).toBe(importedEntries);
  expect(reportIssues(report)).toEqual(codes.map((code) => expect.objectContaining({ code })));
}
function pendingPlugin(pluginId = fixturePlugin, requiresStateMigration?: true) {
  return {
    pluginId,
    reason: "Plugin is unavailable.",
    command: "openclaw doctor --fix",
    ...(requiresStateMigration ? { requiresStateMigration } : {}),
  };
}
function expectPending(env: NodeJS.ProcessEnv, ...pluginIds: string[]) {
  expect(readPending({ env })).toEqual(
    pluginIds.map((pluginId) => expect.objectContaining({ pluginId })),
  );
}
function manifestTargets(env: NodeJS.ProcessEnv) {
  return migrationRun
    .listSessionSqliteMigrationManifestPaths(env)
    .flatMap((file) => migrationRun.readSessionSqliteMigrationManifest(file)?.targets ?? []);
}
function expectArchived(
  moves: ReturnType<typeof manifestTargets>[number]["plannedMoves"],
  source: string,
  bytes: Buffer | undefined,
) {
  const move = moves.find((candidate) => candidate.sourcePath === source);
  expect(move?.artifact?.classification).toBe("protected");
  expect(fs.readFileSync(move!.archivePath)).toEqual(bytes);
}
function expectTranscriptsArchived(originals: Map<string, Buffer>) {
  expectMissing(...[...originals.keys()].filter((name) => name.endsWith(".jsonl")));
}
async function expectInterruptedPublication(run: () => Promise<DoctorSessionSqliteReport>) {
  using publication = vi.spyOn(migrationRun, "recordCompletedMigrationMoves");
  publication.mockImplementationOnce(() => {
    throw new Error("interrupted after transcript publication");
  });
  await expect(run()).rejects.toThrow("interrupted after transcript publication");
}

function importSessions(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  return runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
}
function expectReady(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  expect(() => assertMigrated({ cfg, env })).not.toThrow();
}
function expectOriginals(originals: Map<string, Buffer>, links?: number) {
  for (const [file, bytes] of originals) {
    expectFiles(bytes, file);
    if (links !== undefined) {
      expect(fs.statSync(file).nlink).toBe(links);
    }
  }
}
function resolvePlugin(env: NodeJS.ProcessEnv) {
  return recordPending({ env, pending: [], resolvedPluginIds: [fixturePlugin] });
}
async function emptySource(state: Parameters<typeof seedSource>[0]) {
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const directory = state.sessionsDir("main");
  fs.mkdirSync(directory, { recursive: true });
  const storePath = path.join(directory, "sessions.json");
  fs.writeFileSync(storePath, "{}");
  await recordPending({ env: state.env, pending: [pendingPlugin()] });
  return { cfg, directory, storePath };
}

type SessionScope = Awaited<ReturnType<typeof seedSource>>["scope"];

function expectCanonicalSessions(scope: SessionScope, label: string) {
  expect(loadEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(label);
  expect(loadEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
}

it.each([
  { damage: "both", interrupted: false },
  { damage: "transcript_malformed", interrupted: true },
])(
  "admits verified partial imports with $damage without replaying or retiring damaged history (archive interrupted: $interrupted)",
  ({ damage, interrupted }) =>
    withState({ label: "deferred-damaged-session-source" }, async (state) => {
      const { cfg, storePath, originals, scope } = await seedSource(state, "default");
      const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
      if (damage !== "transcript_malformed") {
        const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
        entries["agent:main:invalid"] = { updatedAt: 20 };
        writeJson(storePath, entries);
        originals.set(storePath, fs.readFileSync(storePath));
      }
      fs.appendFileSync(transcript, '{broken\n{"type":"message","id":"unimported"}\n');
      originals.set(transcript, fs.readFileSync(transcript));
      const run = () => importSessions(cfg, state.env);
      const imported = await run();
      expect(imported.totals).toMatchObject({ importedEntries: 2, importedTranscriptEvents: 4 });
      expect(() => assertMigrated({ cfg, env: state.env, operation: "doctor" })).not.toThrow();
      const issues = reportIssues(imported);
      expect(issues.every(isWarning)).toBe(true);
      for (const code of damage === "both" ? ["entry_invalid", "transcript_malformed"] : [damage]) {
        expect(issues).toContainEqual(expect.objectContaining({ code }));
      }
      expectOriginals(originals);
      await editAndDeleteImportedSessions(scope, "changed after partial import");
      const retried = await run();
      expect(retried.totals.importedEntries).toBe(0);
      expect(reportIssues(retried).every(isWarning)).toBe(true);
      expectCanonicalSessions(scope, "changed after partial import");
      await resolvePlugin(state.env);
      if (interrupted) {
        await expectInterruptedPublication(run);
      }
      const settled = await run();
      expect(settled.totals.importedEntries).toBe(0);
      expectIssue(settled, "transcript_malformed");
      expectReady(cfg, state.env);
      const moves = manifestTargets(state.env).flatMap((target) => target.plannedMoves);
      for (const source of [storePath, transcript]) {
        expectArchived(moves, source, originals.get(source));
      }
    }),
);

it.each([
  { kind: "transcript", unusedAgent: false },
  { kind: "legacy-store", unusedAgent: true },
])(
  "retains an ordinary import's $kind when another Doctor records pending work before unlink (unused agent: $unusedAgent)",
  ({ kind, unusedAgent }) =>
    withState({ label: "deferred-plugin-archive-race" }, async (state) => {
      const { cfg, storePath, originals, scope } = await seedSource(state);
      const unusedDatabase = resolveTarget(storePath, { agentId: "ops", env: state.env }).path;
      if (unusedAgent) {
        cfg.agents = { ...cfg.agents, entries: { ...cfg.agents?.entries, ops: {} } };
      }
      const run = () => importSessions(cfg, state.env);
      await resolvePlugin(state.env);
      const protectedSource =
        kind === "legacy-store"
          ? storePath
          : path.join(path.dirname(storePath), "legacy-kept.jsonl");
      let pendingChanged = false;
      const publish = durability.publishFileExclusive;
      const publication = vi
        .spyOn(durability, "publishFileExclusive")
        .mockImplementation(async (options) => {
          const result = await publish(options);
          if (!pendingChanged && options.sourcePath === protectedSource) {
            pendingChanged = true;
            await recordPending({
              env: state.env,
              pending: [pendingPlugin(fixturePlugin, true)],
            });
          }
          return result;
        });

      const interrupted = await run();
      publication.mockRestore();
      if (unusedAgent) {
        expect(fs.existsSync(unusedDatabase)).toBe(false);
      }
      expect(pendingChanged).toBe(true);
      expect(fs.existsSync(protectedSource)).toBe(true);
      expect(fs.statSync(protectedSource).nlink).toBe(1);
      expect(fs.readFileSync(protectedSource)).toEqual(originals.get(protectedSource));
      expect(readPending({ env: state.env })).toEqual([
        expect.objectContaining({ pluginId: fixturePlugin, requiresStateMigration: true }),
      ]);
      containsObjects(reportIssues(interrupted), {
        message: expect.stringContaining("Plugin migration obligations changed"),
      });

      await editAndDeleteImportedSessions(scope, "edited after interrupted archival");
      expect((await run()).totals.importedEntries).toBe(0);
      expectCanonicalSessions(scope, "edited after interrupted archival");
      expect(fs.readFileSync(protectedSource)).toEqual(originals.get(protectedSource));

      await resolvePlugin(state.env);
      expectImport(await run(), 0);
      expectMissing(storePath);
      expectTranscriptsArchived(originals);
    }),
);

it.each([
  "unchanged source",
  "changed orphan",
  "pending sibling",
  "new plugin obligation",
  "new publication obligation",
  "absent transcript",
])("settles a retained source in the same Doctor after late plugin completion (%s)", (name) =>
  withState({ label: "deferred-plugin-late-settlement" }, async (state) => {
    const changeSource = name === "changed orphan";
    const missingTranscript = changeSource || name === "absent transcript";
    const pendingChange =
      name === "new plugin obligation"
        ? "plugin"
        : name === "new publication obligation"
          ? "publication"
          : "none";
    const seeded = await seedSource(
      state,
      "external",
      fixturePlugin,
      missingTranscript ? "declared" : undefined,
    );
    const { cfg: initialCfg, storePath, originals, scope } = seeded;
    const archiveInputs = new Map(
      [
        "deleted-orphan-one.jsonl",
        "deleted-orphan-two.jsonl",
        "deleted-orphan-one.trajectory.jsonl",
        "legacy-kept.trajectory.jsonl",
        "legacy-kept.trajectory-path.json",
      ].map((artifact) => {
        const file = path.join(path.dirname(storePath), artifact);
        const bytes = Buffer.from(JSON.stringify({ artifact }) + "\n");
        fs.writeFileSync(file, bytes);
        originals.set(file, bytes);
        return [file, bytes] as const;
      }),
    );
    const changedSource = changeSource
      ? path.join(path.dirname(storePath), "deleted-orphan-one.jsonl")
      : storePath;
    if (name === "pending sibling") {
      await recordPending({ env: state.env, pending: [pendingPlugin("waiting-plugin")] });
    }
    await importSessions(initialCfg, state.env);
    await editAndDeleteImportedSessions(scope, "changed after import");
    const pluginRoot = state.path(fixturePlugin);
    const marker = state.path("late-migration-pending");
    const newHistoryId = "new-history";
    const newHistory = path.join(path.dirname(storePath), `${newHistoryId}.jsonl`);
    const newHistoryBytes =
      JSON.stringify({ type: "session", version: 3, id: newHistoryId }) + "\n";
    fs.mkdirSync(pluginRoot);
    fs.writeFileSync(marker, "pending");
    writeJson(path.join(pluginRoot, "package.json"), {
      name: "@example/fixture-plugin",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    });
    fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
    const migrationAction = { id: "late-state", phase: "after-session-repair", doctorOnly: true };
    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: fixturePlugin,
      configSchema: { type: "object", properties: {}, additionalProperties: false },
      doctorContract: { stateMigrations: [migrationAction] },
    });
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      `const fs = require("node:fs");
          module.exports = { stateMigrations: [{
            ...${JSON.stringify(migrationAction)}, label: "Late fixture state",
            detectLegacyState: () => fs.existsSync(${JSON.stringify(marker)}) ? { preview: ["Consume retained fixture state"] } : null,
            migrateLegacyState: () => {
              fs.writeFileSync(${JSON.stringify(newHistory)}, ${JSON.stringify(newHistoryBytes)});
              ${changeSource ? `fs.appendFileSync(${JSON.stringify(changedSource)}, "\\n");` : ""}
              fs.unlinkSync(${JSON.stringify(marker)});
              return { changes: ["Consumed retained fixture state"], warnings: [] };
            },
          }] };\n`,
    );
    const cfg: OpenClawConfig = {
      ...initialCfg,
      plugins: {
        allow: [fixturePlugin],
        entries: { [fixturePlugin]: { enabled: true } },
        load: { paths: [pluginRoot] },
      },
    };
    let pendingChanged = false;
    const changePending = () => {
      pendingChanged = true;
      seedConcurrent(state, pendingChange === "plugin" ? fixturePlugin : "new-plugin");
    };
    if (pendingChange === "plugin") {
      const unlink = fs.unlinkSync;
      vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        unlink(file);
        if (file === marker) {
          changePending();
        }
      });
    } else if (pendingChange === "publication") {
      const publish = durability.publishFileExclusive;
      vi.spyOn(durability, "publishFileExclusive").mockImplementation(async (options) => {
        const result = await publish(options);
        if (
          !pendingChanged &&
          originals.has(options.sourcePath) &&
          options.sourcePath.endsWith(".jsonl")
        ) {
          changePending();
        }
        return result;
      });
    }
    await noteSessionTranscriptHealth({ cfg, env: state.env, shouldRepair: true });
    expectMissing(marker);
    expectFiles(newHistoryBytes, newHistory);
    expectCanonicalSessions(scope, "changed after import");
    if (pendingChange === "none") {
      expectReady(cfg, state.env);
    }
    if (pendingChange !== "none") {
      expect(pendingChanged).toBe(true);
      const pending = readPending({ env: state.env });
      expect(pending.map((plugin) => plugin.pluginId)).toEqual(
        pendingChange === "plugin" ? [fixturePlugin] : [fixturePlugin, "new-plugin"],
      );
      expect(pending).toContainEqual(
        expect.objectContaining({
          pluginId: pendingChange === "plugin" ? fixturePlugin : "new-plugin",
          requiresStateMigration: true,
        }),
      );
      expectOriginals(originals, pendingChange === "publication" ? 1 : undefined);
    } else if (changeSource) {
      expectPending(state.env, fixturePlugin);
      expect(fs.readFileSync(changedSource, "utf8")).toBe(
        originals.get(changedSource)?.toString() + "\n",
      );
    } else if (name === "pending sibling") {
      expectPending(state.env, "waiting-plugin");
      expectOriginals(originals);
    } else {
      expectPending(state.env);
      expectMissing(storePath);
      const archived = manifestTargets(state.env).filter((target) =>
        target.completedMoves.some((move) => move.sourcePath === storePath),
      );
      expect(archived).toEqual([expect.objectContaining({ validationBeforeArchive: "passed" })]);
      for (const [file, bytes] of archiveInputs) {
        expectMissing(file);
        expectArchived(archived[0]!.completedMoves, file, bytes);
      }
      if (missingTranscript) {
        expect(archived[0]?.issues).toContainEqual(
          expect.objectContaining({ code: "transcript_missing" }),
        );
        expectArchived(archived[0]!.completedMoves, storePath, originals.get(storePath));
      }
      expectTranscriptsArchived(originals);
    }
  }),
);

it.each(["default", "configured-root", "relocated-interrupted"] as const)(
  "verifies canonical import and retains %s originals until resolution without replay",
  (layout) =>
    withState({ label: "deferred-plugin-session-source" }, async (state) => {
      const { cfg, storePath, originals, scope } = await seedSource(
        state,
        layout === "configured-root" ? "legacy-root" : "default",
      );
      if (layout === "configured-root") {
        scope.storePath = storePath;
        cfg.session = { store: storePath };
      }
      let foreignSource: { path: string; bytes: Buffer } | undefined;
      if (layout === "relocated-interrupted") {
        const foreignPath = state.path("foreign-root/agents/main/sessions/legacy-kept.jsonl");
        const bytes = fs.readFileSync(path.join(path.dirname(storePath), "legacy-kept.jsonl"));
        fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
        fs.writeFileSync(foreignPath, bytes);
        foreignSource = { path: foreignPath, bytes };
        const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
        entries["agent:main:kept"].sessionFile = foreignPath;
        writeJson(storePath, entries);
        originals.set(storePath, fs.readFileSync(storePath));
      }
      expect(() => assertMigrated({ cfg, env: state.env })).toThrow(
        "Legacy session store requires migration",
      );
      const run = () => importSessions(cfg, state.env);
      const imported = await run();
      expectImport(imported, 2, "plugin_migration_source_retained");
      expectOriginals(originals);
      closeAgentHandles();
      closeStateHandles();
      expectReady(cfg, state.env);
      await editAndDeleteImportedSessions(scope, "changed after import");
      expect((await run()).totals.importedEntries).toBe(0);
      expectCanonicalSessions(scope, "changed after import");
      expectOriginals(originals);
      await resolvePlugin(state.env);
      if (layout === "default" || layout === "configured-root") {
        const identities = new Map(
          [...originals.keys()].map((file) => [file, artifactIdentity(file)]),
        );
        await autoMigrateLegacyState({
          cfg,
          env: state.env,
          homedir: () => state.home,
          doctorOnlyStateMigrations: true,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });
        for (const [file, identity] of identities) {
          expect(artifactIdentity(file), file).toEqual(identity);
        }
      }
      if (layout === "relocated-interrupted") {
        await expectInterruptedPublication(run);
        expectTranscriptsArchived(originals);
        expect(fs.readFileSync(storePath)).toEqual(originals.get(storePath));
      }
      const resumed = await run();
      expectImport(resumed, 0);
      expectMissing(storePath);
      expect(resumed.totals.archivedTranscriptFiles).toBe(
        layout === "relocated-interrupted" ? 0 : 2,
      );
      expectCanonicalSessions(scope, "changed after import");
      expectReady(cfg, state.env);
      if (foreignSource) {
        expect(fs.readFileSync(foreignSource.path)).toEqual(foreignSource.bytes);
      }
    }),
);

it("lets startup proceed for an empty index when the owner has no database yet", () =>
  withState({ label: "deferred-empty-index-no-db" }, async (state) => {
    const { cfg, storePath } = await emptySource(state);
    expectReady(cfg, state.env);
    const report = await importSessions(cfg, state.env);
    expect(report.totals.importedEntries).toBe(0);
    expectReady(cfg, state.env);
    const sqlitePath = resolveTarget(storePath, { agentId: "main", env: state.env }).path;
    expect(fs.existsSync(sqlitePath)).toBe(false);
    expect(fs.readFileSync(storePath, "utf8")).toBe("{}");
  }));

it.each(["unindexed history", "a removed receipt database"] as const)(
  "keeps startup blocked for an empty index with %s",
  (kind) =>
    withState({ label: "deferred-empty-index-required" }, async (state) => {
      openOpenClawStateDatabase({ env: state.env });
      const { cfg, directory, storePath } = await emptySource(state);
      const scope = { agentId: "main", storePath, env: state.env };
      const sqlitePath = resolveTarget(storePath, scope).path;
      const run = () => importSessions(cfg, state.env);
      if (kind === "unindexed history") {
        writeTranscript(path.join(directory, "historical.jsonl"), "historical");
      } else {
        await upsertEntry(
          { ...scope, sessionKey: "agent:main:current" },
          { sessionId: "current", updatedAt: 1 },
        );
        const report = await run();
        expect(report.totals.importedEntries).toBe(0);
        expectIssue(report, "plugin_migration_source_retained");
        expectReady(cfg, state.env);
        closeAgentHandles();
        fs.unlinkSync(sqlitePath);
      }
      expect(fs.existsSync(sqlitePath)).toBe(false);
      expect(() => assertMigrated({ cfg, env: state.env })).toThrow(
        kind === "unindexed history"
          ? SessionStoreMigrationRequiredError
          : expect.objectContaining({
              message: expect.stringContaining(
                `The imported session database is missing or no longer a regular file: ${sqlitePath}. Run openclaw doctor --session-sqlite recover --session-sqlite-all-agents`,
              ),
            }),
      );
      if (kind === "unindexed history") {
        const report = await run();
        expectImport(report, 1, "plugin_migration_source_retained");
        expect(
          loadEntry({ ...scope, sessionKey: "agent:main:recovered:historical" })?.entry.sessionId,
        ).toBe("historical");
        expectReady(cfg, state.env);
      }
      expect(fs.readFileSync(storePath, "utf8")).toBe("{}");
    }),
);

it("admits a configured shared source only after the live owner has a verified import", () =>
  withState({ label: "deferred-mixed-retained-owner" }, async (state) => {
    const { cfg, storePath, originals, scope } = await seedSource(state);
    cfg.agents = { ownership: "explicit", entries: { main: {}, retired: {} } };
    const retiredPath = openOpenClawAgentDatabase({
      agentId: "retired",
      env: state.env,
      path: resolveTarget(storePath, { agentId: "retired", env: state.env }).path,
    }).path;
    closeAgentHandles();
    const deletion = beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId: "delete-mixed-retired-owner",
        agentDir: state.agentDir("retired"),
        sessionsDir: state.sessionsDir("retired"),
        workspaceDir: state.statePath("workspace-retired"),
        databasePaths: [retiredPath],
        deleteFiles: false,
      },
      { env: state.env },
    );
    runOpenClawStateWriteTransaction(
      (database) =>
        completeAgentDeletionJournalInDatabase(database, "retired", deletion.operationId),
      { env: state.env },
    );
    const retiredTranscript = path.join(path.dirname(storePath), "legacy-retired.jsonl");
    writeTranscript(retiredTranscript, "legacy-retired");
    const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
    entries["agent:retired:waiting"] = {
      sessionId: "legacy-retired",
      sessionFile: path.basename(retiredTranscript),
      updatedAt: 1,
    };
    writeJson(storePath, entries);
    for (const file of [storePath, retiredPath, retiredTranscript]) {
      originals.set(file, fs.readFileSync(file));
    }
    const assertReady = () => assertMigrated({ cfg, env: state.env, operation: "doctor" });
    expect(assertReady).toThrow("Legacy session store requires migration");

    const imported = await importSessions(cfg, state.env);
    expect(imported.totals).toMatchObject({ importedEntries: 2, importedTranscriptEvents: 4 });
    expectIssue(imported, "plugin_migration_source_retained");
    closeAgentHandles();
    closeStateHandles();
    expect(assertReady).not.toThrow();
    expect(loadEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.sessionId).toBe(
      "legacy-kept",
    );
    expectOriginals(originals);

    fs.appendFileSync(storePath, "\n");
    expect(assertReady).not.toThrow();
    entries["voice:unassigned"] = { sessionId: "unassigned", updatedAt: 1 };
    writeJson(storePath, entries);
    expect(assertReady).toThrow("Legacy session store requires migration");
    expect(fs.readFileSync(retiredPath)).toEqual(originals.get(retiredPath));
    expect(fs.readFileSync(retiredTranscript)).toEqual(originals.get(retiredTranscript));
  }));

it.each(["unimported-owner", "malformed", "unreadable"] as const)(
  "keeps readiness blocked for a retained source with %s state",
  (kind) =>
    withState({ label: `deferred-readiness-${kind}` }, async (state) => {
      const { cfg, storePath } = await seedSource(state);
      cfg.agents = {
        ownership: "explicit",
        ...(kind === "unimported-owner" ? { defaults: { sessionStore: { agentId: "main" } } } : {}),
        entries: { main: {}, ...(kind === "unimported-owner" ? { ops: {} } : {}) },
      };
      const source = JSON.parse(fs.readFileSync(storePath, "utf8"));
      if (kind === "malformed") {
        fs.writeFileSync(storePath, "{");
      } else if (kind === "unreadable") {
        fs.unlinkSync(storePath);
        fs.mkdirSync(storePath);
      } else {
        source["agent:ops:waiting"] = { sessionId: "waiting", updatedAt: 1 };
        writeJson(storePath, source);
      }
      const run = () =>
        runDoctorSessionSqlite({
          cfg,
          env: state.env,
          mode: "import",
          ...(kind === "unimported-owner"
            ? { store: storePath, agent: "main" }
            : { allAgents: true }),
        });
      if (kind === "unreadable") {
        await expect(run()).rejects.toThrow("not an unaliased regular file");
      } else {
        const imported = await run();
        if (kind !== "malformed") {
          expect(imported.totals.importedEntries).toBe(2);
          expectIssue(imported, "plugin_migration_source_retained");
        }
      }
      expectMissing(resolveTarget(storePath, { agentId: "ops", env: state.env }).path);
      expect(() => assertMigrated({ cfg, env: state.env })).toThrow(
        "Legacy session store requires migration",
      );
      expect(fs.existsSync(storePath)).toBe(true);
    }),
);

it.each(["declared", "metadata-only"] as const)(
  "imports a previously %s missing transcript without replaying canonical metadata",
  (kind) =>
    withState({ label: "deferred-transcript-appears" }, async (state) => {
      const { cfg, storePath, originals, scope } = await seedSource(
        state,
        "default",
        fixturePlugin,
        kind,
      );
      await importSessions(cfg, state.env);
      await upsertEntry({ ...scope, sessionKey: "agent:main:kept" }, { label: "current" });
      const transcript = path.join(path.dirname(storePath), "legacy-missing.jsonl");
      const contents = '{"type":"session","version":3,"id":"legacy-missing"}\n';
      fs.writeFileSync(transcript, contents);
      const retry = await importSessions(cfg, state.env);
      const issues = reportIssues(retry);
      containsObjects(issues, { code: "retained_plugin_source_conflict" });
      expect(issues.every(isWarning)).toBe(true);
      expect(retry.totals).toMatchObject({ importedEntries: 0, archivedTranscriptFiles: 1 });
      expect(fs.existsSync(transcript)).toBe(false);
      const manifest = migrationRun.readSessionSqliteMigrationManifest(
        retry.migrationRun!.manifestPath,
      )!;
      const archived = manifest.targets
        .flatMap((target) => target.completedMoves)
        .find((move) => move.sourcePath === transcript)!;
      expect(archived.artifact?.classification).toBe("imported");
      expect(loadTranscriptEventsSync({ ...scope, sessionId: "legacy-missing" })).toEqual([
        expect.objectContaining({ type: "session", id: "legacy-missing" }),
      ]);
      expect(fs.readFileSync(archived.archivePath, "utf8")).toBe(contents);
      expectOriginals(originals);
      expect(loadEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe("current");
      expectReady(cfg, state.env);
    }),
);
