import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import * as directoryDurability from "../infra/directory-durability.js";
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
  seedConcurrentDeferredPluginMigration,
  seedDeferredPluginSessionSource as seedSource,
} from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

afterEach(() => vi.restoreAllMocks());

function importSessions(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  return runDoctorSessionSqlite({ cfg, env, allAgents: true, mode: "import" });
}
function expectReady(cfg: OpenClawConfig, env: NodeJS.ProcessEnv) {
  expect(() => assertMigrated({ cfg, env })).not.toThrow();
}
function expectOriginals(originals: Map<string, Buffer>) {
  for (const [file, bytes] of originals) {
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
}
function resolvePlugin(env: NodeJS.ProcessEnv) {
  return recordPending({
    env,
    pending: [],
    resolvedPluginIds: ["fixture-plugin"],
  });
}
async function emptySource(state: Parameters<typeof seedSource>[0]) {
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const directory = state.sessionsDir("main");
  fs.mkdirSync(directory, { recursive: true });
  const storePath = path.join(directory, "sessions.json");
  fs.writeFileSync(storePath, "{}");
  await recordPending({
    env: state.env,
    pending: [
      {
        pluginId: "fixture-plugin",
        reason: "Plugin is unavailable.",
        command: "openclaw doctor --fix",
      },
    ],
  });
  return { cfg, directory, storePath };
}
function settlementScenario(
  overrides: Partial<{
    changeSource: boolean | string;
    siblingPending: boolean;
    pendingChange: string;
    missingTranscript: string;
  }> = {},
) {
  return {
    changeSource: false,
    siblingPending: false,
    pendingChange: "none",
    missingTranscript: "none",
    ...overrides,
  };
}

type SessionScope = Awaited<ReturnType<typeof seedSource>>["scope"];

function expectCanonicalSessions(scope: SessionScope, label: string) {
  expect(loadEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(label);
  expect(loadEntry({ ...scope, sessionKey: "agent:main:deleted" })).toBeUndefined();
}

describe("session sources needed by deferred plugin migrations", () => {
  it.each([
    { damage: "both", interrupted: false },
    { damage: "transcript_malformed", interrupted: true },
  ])(
    "admits verified partial imports with $damage without replaying or retiring damaged history (archive interrupted: $interrupted)",
    async ({ damage, interrupted }) => {
      await withState({ label: "deferred-damaged-session-source" }, async (state) => {
        const { cfg, storePath, originals, scope } = await seedSource(state, "default");
        const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
        if (damage !== "transcript_malformed") {
          const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
          entries["agent:main:invalid"] = { updatedAt: 20 };
          fs.writeFileSync(storePath, JSON.stringify(entries));
          originals.set(storePath, fs.readFileSync(storePath));
        }
        {
          fs.appendFileSync(transcript, '{broken\n{"type":"message","id":"unimported"}\n');
          originals.set(transcript, fs.readFileSync(transcript));
        }
        const run = () => importSessions(cfg, state.env);
        const imported = await run();
        expect(imported.totals.importedEntries).toBe(2);
        expect(imported.totals.importedTranscriptEvents).toBe(4);
        // This is the same readiness decision made by doctor --non-interactive --fix.
        expect(() => assertMigrated({ cfg, env: state.env, operation: "doctor" })).not.toThrow();
        const issues = imported.targets.flatMap((target) => target.issues);
        expect(issues.every(isWarning)).toBe(true);
        for (const code of damage === "both"
          ? ["entry_invalid", "transcript_malformed"]
          : [damage]) {
          expect(issues).toContainEqual(expect.objectContaining({ code }));
        }
        expectOriginals(originals);
        await editAndDeleteImportedSessions(scope, "changed after partial import");
        const retried = await run();
        expect(retried.totals.importedEntries).toBe(0);
        expect(retried.targets.flatMap((target) => target.issues).every(isWarning)).toBe(true);
        expectCanonicalSessions(scope, "changed after partial import");
        await resolvePlugin(state.env);
        if (interrupted) {
          const publication = vi
            .spyOn(migrationRun, "recordCompletedMigrationMoves")
            .mockImplementationOnce(() => {
              throw new Error("interrupted after transcript publication");
            });
          await expect(run()).rejects.toThrow("interrupted after transcript publication");
          publication.mockRestore();
        }
        const settled = await run();
        expect(settled.totals.importedEntries).toBe(0);
        expect(settled.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({ code: "transcript_malformed" }),
        );
        expectReady(cfg, state.env);
        const moves = migrationRun
          .listSessionSqliteMigrationManifestPaths(state.env)
          .flatMap((file) => migrationRun.readSessionSqliteMigrationManifest(file)?.targets ?? [])
          .flatMap((target) => target.plannedMoves);
        for (const source of [storePath, transcript]) {
          const move = moves.find((candidate) => candidate.sourcePath === source);
          expect(move?.artifact?.classification).toBe("protected");
          expect(fs.readFileSync(move!.archivePath)).toEqual(originals.get(source));
        }
      });
    },
  );

  it.each([
    { kind: "transcript", unusedAgent: false },
    { kind: "legacy-store", unusedAgent: true },
  ])(
    "retains an ordinary import's $kind when another Doctor records pending work before unlink (unused agent: $unusedAgent)",
    async ({ kind, unusedAgent }) => {
      await withState({ label: "deferred-plugin-archive-race" }, async (state) => {
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
        const publish = directoryDurability.publishFileExclusive;
        const publication = vi
          .spyOn(directoryDurability, "publishFileExclusive")
          .mockImplementation(async (options) => {
            const result = await publish(options);
            if (!pendingChanged && options.sourcePath === protectedSource) {
              pendingChanged = true;
              await recordPending({
                env: state.env,
                pending: [
                  {
                    pluginId: "fixture-plugin",
                    reason: "Another Doctor found additional state migration work.",
                    command: "openclaw doctor --fix",
                    requiresStateMigration: true,
                  },
                ],
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
          expect.objectContaining({ pluginId: "fixture-plugin", requiresStateMigration: true }),
        ]);
        expect(interrupted.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining("Plugin migration obligations changed"),
          }),
        );

        await editAndDeleteImportedSessions(scope, "edited after interrupted archival");
        expect((await run()).totals.importedEntries).toBe(0);
        expectCanonicalSessions(scope, "edited after interrupted archival");
        expect(fs.readFileSync(protectedSource)).toEqual(originals.get(protectedSource));

        await resolvePlugin(state.env);
        const resumed = await run();
        expect(resumed.totals.importedEntries).toBe(0);
        expect(resumed.targets.flatMap((target) => target.issues)).toEqual([]);
        expect(fs.existsSync(storePath)).toBe(false);
        for (const source of originals.keys()) {
          if (source.endsWith(".jsonl")) {
            expect(fs.existsSync(source)).toBe(false);
          }
        }
      });
    },
  );

  it.each([
    settlementScenario(),
    settlementScenario({ changeSource: "orphan", missingTranscript: "absent" }),
    settlementScenario({ siblingPending: true }),
    settlementScenario({ pendingChange: "plugin" }),
    settlementScenario({ pendingChange: "publication" }),
    settlementScenario({ missingTranscript: "absent" }),
  ])(
    "settles a retained source in the same Doctor after late plugin completion (source changed: $changeSource, sibling pending: $siblingPending, pending change: $pendingChange, missing transcript: $missingTranscript)",
    async ({ changeSource, siblingPending, pendingChange, missingTranscript }) => {
      await withState({ label: "deferred-plugin-late-settlement" }, async (state) => {
        const {
          cfg: seededConfig,
          storePath,
          originals,
          scope,
        } = await seedSource(
          state,
          "external",
          "fixture-plugin",
          missingTranscript === "none" ? undefined : "declared",
        );
        const archiveInputs = new Map(
          [
            "deleted-orphan-one.jsonl",
            "deleted-orphan-two.jsonl",
            "deleted-orphan-one.trajectory.jsonl",
            "legacy-kept.trajectory.jsonl",
            "legacy-kept.trajectory-path.json",
          ].map((name) => {
            const file = path.join(path.dirname(storePath), name);
            const bytes = Buffer.from(JSON.stringify({ artifact: name }) + "\n");
            fs.writeFileSync(file, bytes);
            originals.set(file, bytes);
            return [file, bytes] as const;
          }),
        );
        const changedSource =
          changeSource === "orphan"
            ? path.join(path.dirname(storePath), "deleted-orphan-one.jsonl")
            : storePath;
        if (siblingPending) {
          await recordPending({
            env: state.env,
            pending: [
              {
                pluginId: "waiting-plugin",
                reason: "Another plugin still needs the original session sources.",
                command: "openclaw doctor --fix",
              },
            ],
          });
        }
        await importSessions(seededConfig, state.env);
        await editAndDeleteImportedSessions(scope, "changed after import");
        const pluginRoot = state.path("fixture-plugin");
        const marker = state.path("late-migration-pending");
        const newHistoryId = "new-history";
        const newHistory = path.join(path.dirname(storePath), `${newHistoryId}.jsonl`);
        const newHistoryBytes =
          JSON.stringify({ type: "session", version: 3, id: newHistoryId }) + "\n";
        fs.mkdirSync(pluginRoot);
        fs.writeFileSync(marker, "pending");
        fs.writeFileSync(
          path.join(pluginRoot, "package.json"),
          JSON.stringify({
            name: "@example/fixture-plugin",
            version: "1.0.0",
            openclaw: { extensions: ["./index.cjs"] },
          }),
        );
        fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
        fs.writeFileSync(
          path.join(pluginRoot, "openclaw.plugin.json"),
          JSON.stringify({
            id: "fixture-plugin",
            configSchema: { type: "object", properties: {}, additionalProperties: false },
            doctorContract: {
              stateMigrations: [
                { id: "late-state", phase: "after-session-repair", doctorOnly: true },
              ],
            },
          }),
        );
        fs.writeFileSync(
          path.join(pluginRoot, "doctor-contract-api.cjs"),
          `const fs = require("node:fs");
          module.exports = { stateMigrations: [{
            id: "late-state", label: "Late fixture state", phase: "after-session-repair", doctorOnly: true,
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
          ...seededConfig,
          plugins: {
            allow: ["fixture-plugin"],
            entries: { "fixture-plugin": { enabled: true } },
            load: { paths: [pluginRoot] },
          },
        };
        let pendingChanged = false;
        const changePending = () => {
          pendingChanged = true;
          seedConcurrentDeferredPluginMigration(
            state,
            pendingChange === "plugin" ? "fixture-plugin" : "new-plugin",
          );
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
          const publish = directoryDurability.publishFileExclusive;
          vi.spyOn(directoryDurability, "publishFileExclusive").mockImplementation(
            async (options) => {
              const result = await publish(options);
              if (
                !pendingChanged &&
                originals.has(options.sourcePath) &&
                options.sourcePath.endsWith(".jsonl")
              ) {
                changePending();
              }
              return result;
            },
          );
        }
        await noteSessionTranscriptHealth({ cfg, env: state.env, shouldRepair: true });
        expect(fs.existsSync(marker)).toBe(false);
        expect(fs.readFileSync(newHistory, "utf8")).toBe(newHistoryBytes);
        expectCanonicalSessions(scope, "changed after import");
        if (pendingChange !== "none") {
          expect(pendingChanged).toBe(true);
          const pending = readPending({ env: state.env });
          expect(pending.map((plugin) => plugin.pluginId)).toEqual(
            pendingChange === "plugin" ? ["fixture-plugin"] : ["fixture-plugin", "new-plugin"],
          );
          expect(pending).toContainEqual(
            expect.objectContaining({
              pluginId: pendingChange === "plugin" ? "fixture-plugin" : "new-plugin",
              requiresStateMigration: true,
            }),
          );
          for (const [file, bytes] of originals) {
            expect(fs.readFileSync(file)).toEqual(bytes);
            if (pendingChange === "publication") {
              expect(fs.statSync(file).nlink).toBe(1);
            }
          }
        } else if (changeSource || missingTranscript === "appears") {
          expectReady(cfg, state.env);
          expect(readPending({ env: state.env })).toEqual([
            expect.objectContaining({ pluginId: "fixture-plugin" }),
          ]);
          expect(fs.readFileSync(changedSource, "utf8")).toBe(
            originals.get(changedSource)?.toString() + (changeSource ? "\n" : ""),
          );
        } else if (siblingPending) {
          expectReady(cfg, state.env);
          expect(readPending({ env: state.env })).toEqual([
            expect.objectContaining({ pluginId: "waiting-plugin" }),
          ]);
          expectOriginals(originals);
        } else {
          expectReady(cfg, state.env);
          expect(readPending({ env: state.env })).toEqual([]);
          expect(fs.existsSync(storePath)).toBe(false);
          const archived = migrationRun
            .listSessionSqliteMigrationManifestPaths(state.env)
            .map((manifestPath) => migrationRun.readSessionSqliteMigrationManifest(manifestPath))
            .flatMap((manifest) => manifest?.targets ?? [])
            .filter((target) =>
              target.completedMoves.some((move) => move.sourcePath === storePath),
            );
          expect(archived).toEqual([
            expect.objectContaining({ validationBeforeArchive: "passed" }),
          ]);
          for (const [file, bytes] of archiveInputs) {
            expect(fs.existsSync(file)).toBe(false);
            const move = archived[0]?.completedMoves.find(
              (candidate) => candidate.sourcePath === file,
            );
            expect(move?.artifact?.classification).toBe("protected");
            expect(fs.readFileSync(move!.archivePath)).toEqual(bytes);
          }
          if (missingTranscript === "absent") {
            expect(archived[0]?.issues).toContainEqual(
              expect.objectContaining({ code: "transcript_missing" }),
            );
            expect(
              archived[0]?.completedMoves.find((move) => move.sourcePath === storePath)?.artifact
                ?.classification,
            ).toBe("protected");
          }
          for (const file of originals.keys()) {
            if (file.endsWith(".jsonl")) {
              expect(fs.existsSync(file)).toBe(false);
            }
          }
        }
      });
    },
  );

  it.each([
    { layout: "default" },
    { layout: "configured-root" },
    { layout: "relocated-interrupted" },
  ] as const)(
    "verifies canonical import and retains $layout originals until resolution without replay",
    async ({ layout }) => {
      await withState({ label: "deferred-plugin-session-source" }, async (state) => {
        const { cfg, storePath, originals, scope } = await seedSource(
          state,
          layout === "configured-root"
            ? "legacy-root"
            : layout === "relocated-interrupted"
              ? "default"
              : layout,
          "fixture-plugin",
          undefined,
        );
        if (layout === "configured-root") {
          scope.storePath = storePath;
          cfg.session = { store: storePath };
        }
        let foreignSource:
          | {
              path: string;
              bytes: Buffer;
            }
          | undefined;
        if (layout === "relocated-interrupted") {
          const foreignPath = state.path("foreign-root/agents/main/sessions/legacy-kept.jsonl");
          const bytes = fs.readFileSync(path.join(path.dirname(storePath), "legacy-kept.jsonl"));
          fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
          fs.writeFileSync(foreignPath, bytes);
          foreignSource = { path: foreignPath, bytes };
          const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
          entries["agent:main:kept"].sessionFile = foreignPath;
          fs.writeFileSync(storePath, JSON.stringify(entries));
          originals.set(storePath, fs.readFileSync(storePath));
        }
        expect(() => assertMigrated({ cfg, env: state.env })).toThrow(
          "Legacy session store requires migration",
        );
        const run = () => importSessions(cfg, state.env);
        const imported = await run();
        expect(imported.totals.importedEntries).toBe(2);
        expect(imported.targets.flatMap((target) => target.issues)).toEqual([
          expect.objectContaining({ code: "plugin_migration_source_retained" }),
        ]);
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
          const publication = vi
            .spyOn(migrationRun, "recordCompletedMigrationMoves")
            .mockImplementationOnce(() => {
              throw new Error("interrupted after transcript publication");
            });
          try {
            await expect(run()).rejects.toThrow("interrupted after transcript publication");
          } finally {
            publication.mockRestore();
          }
          for (const file of originals.keys()) {
            if (file.endsWith(".jsonl")) {
              expect(fs.existsSync(file)).toBe(false);
            }
          }
          expect(fs.readFileSync(storePath)).toEqual(originals.get(storePath));
        }
        const resumed = await run();
        expect(resumed.totals.importedEntries).toBe(0);
        expect(resumed.targets.flatMap((target) => target.issues)).toEqual([]);
        expect(fs.existsSync(storePath)).toBe(false);
        expect(resumed.totals.archivedTranscriptFiles).toBe(
          layout === "relocated-interrupted" ? 0 : 2,
        );
        expectCanonicalSessions(scope, "changed after import");
        expectReady(cfg, state.env);
        if (foreignSource) {
          expect(fs.readFileSync(foreignSource.path)).toEqual(foreignSource.bytes);
        }
      });
    },
  );

  it("lets startup proceed for an empty index when the owner has no database yet", async () => {
    await withState({ label: "deferred-empty-index-no-db" }, async (state) => {
      const { cfg, storePath } = await emptySource(state);
      // No owner can hold a replayable receipt without a database, and a
      // zero-record source has nothing to replay: startup must not demand one.
      expectReady(cfg, state.env);
      const report = await importSessions(cfg, state.env);
      expect(report.totals.importedEntries).toBe(0);
      expectReady(cfg, state.env);
      const sqlitePath = resolveTarget(storePath, { agentId: "main", env: state.env }).path;
      expect(fs.existsSync(sqlitePath)).toBe(false);
      expect(fs.readFileSync(storePath, "utf8")).toBe("{}");
    });
  });

  it.each(["unindexed history", "a removed receipt database"] as const)(
    "keeps startup blocked for an empty index with %s",
    async (kind) => {
      await withState({ label: "deferred-empty-index-required" }, async (state) => {
        openOpenClawStateDatabase({ env: state.env });
        const { cfg, directory, storePath } = await emptySource(state);
        const scope = { agentId: "main", storePath, env: state.env };
        const sqlitePath = resolveTarget(storePath, scope).path;
        const run = () => importSessions(cfg, state.env);
        if (kind === "unindexed history") {
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
        } else {
          await upsertEntry(
            { ...scope, sessionKey: "agent:main:current" },
            { sessionId: "current", updatedAt: 1 },
          );
          const report = await run();
          expect(report.totals.importedEntries).toBe(0);
          expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
            expect.objectContaining({ code: "plugin_migration_source_retained" }),
          );
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
          expect(report.totals.importedEntries).toBe(1);
          expect(report.targets.flatMap((target) => target.issues)).toEqual([
            expect.objectContaining({ code: "plugin_migration_source_retained" }),
          ]);
          expect(
            loadEntry({ ...scope, sessionKey: "agent:main:recovered:historical" })?.entry.sessionId,
          ).toBe("historical");
          expectReady(cfg, state.env);
        }
        expect(fs.readFileSync(storePath, "utf8")).toBe("{}");
      });
    },
  );

  it("admits a configured shared source only after the live owner has a verified import", async () => {
    await withState({ label: "deferred-mixed-retained-owner" }, async (state) => {
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
      fs.writeFileSync(
        retiredTranscript,
        [
          { type: "session", version: 3, id: "legacy-retired" },
          {
            type: "message",
            id: "retired-message",
            parentId: null,
            message: { role: "user", content: "Retained deleted history" },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
      entries["agent:retired:waiting"] = {
        sessionId: "legacy-retired",
        sessionFile: path.basename(retiredTranscript),
        updatedAt: 1,
      };
      fs.writeFileSync(storePath, JSON.stringify(entries));
      for (const file of [storePath, retiredPath, retiredTranscript]) {
        originals.set(file, fs.readFileSync(file));
      }
      const assertReady = () => assertMigrated({ cfg, env: state.env, operation: "doctor" });
      expect(assertReady).toThrow("Legacy session store requires migration");

      const imported = await importSessions(cfg, state.env);
      expect(imported.totals).toMatchObject({ importedEntries: 2, importedTranscriptEvents: 4 });
      expect(imported.targets.flatMap((target) => target.issues)).toContainEqual(
        expect.objectContaining({ code: "plugin_migration_source_retained" }),
      );
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
      fs.writeFileSync(storePath, JSON.stringify(entries));
      expect(assertReady).toThrow("Legacy session store requires migration");
      expect(fs.readFileSync(retiredPath)).toEqual(originals.get(retiredPath));
      expect(fs.readFileSync(retiredTranscript)).toEqual(originals.get(retiredTranscript));
    });
  });

  it.each(["unimported-owner", "malformed", "unreadable"] as const)(
    "keeps readiness blocked for a retained source with %s state",
    async (kind) => {
      await withState({ label: `deferred-readiness-${kind}` }, async (state) => {
        const { cfg, storePath } = await seedSource(state);
        cfg.agents = {
          ownership: "explicit",
          ...(kind === "unimported-owner"
            ? { defaults: { sessionStore: { agentId: "main" } } }
            : {}),
          entries: { main: {}, ...(kind === "unimported-owner" ? { ops: {} } : {}) },
        };
        const source = JSON.parse(fs.readFileSync(storePath, "utf8"));
        if (kind === "malformed") {
          fs.writeFileSync(storePath, "{");
        } else if (kind === "unreadable") {
          fs.unlinkSync(storePath);
          fs.mkdirSync(storePath);
        } else {
          const key = kind === "unimported-owner" ? "agent:ops:waiting" : "agent:retired:waiting";
          source[key] = { sessionId: "waiting", updatedAt: 1 };
          fs.writeFileSync(storePath, JSON.stringify(source));
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
            expect(imported.targets.flatMap((target) => target.issues)).toContainEqual(
              expect.objectContaining({ code: "plugin_migration_source_retained" }),
            );
          }
        }
        expect(
          fs.existsSync(resolveTarget(storePath, { agentId: "ops", env: state.env }).path),
        ).toBe(false);
        expect(() => assertMigrated({ cfg, env: state.env })).toThrow(
          "Legacy session store requires migration",
        );
        expect(fs.existsSync(storePath)).toBe(true);
      });
    },
  );

  it.each(["declared", "metadata-only"] as const)(
    "imports a previously %s missing transcript without replaying canonical metadata",
    async (kind) => {
      await withState({ label: "deferred-transcript-appears" }, async (state) => {
        const { cfg, storePath, originals, scope } = await seedSource(
          state,
          "default",
          "fixture-plugin",
          kind,
        );
        await importSessions(cfg, state.env);
        await upsertEntry({ ...scope, sessionKey: "agent:main:kept" }, { label: "current" });
        const transcript = path.join(path.dirname(storePath), "legacy-missing.jsonl");
        const contents = '{"type":"session","version":3,"id":"legacy-missing"}\n';
        fs.writeFileSync(transcript, contents);
        const retry = await importSessions(cfg, state.env);
        const issues = retry.targets.flatMap((target) => target.issues);
        expect(issues).toContainEqual(
          expect.objectContaining({ code: "retained_plugin_source_conflict" }),
        );
        expect(issues.every(isWarning)).toBe(true);
        expect(retry.totals.importedEntries).toBe(0);
        expect(retry.totals.archivedTranscriptFiles).toBe(1);
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
      });
    },
  );
});
