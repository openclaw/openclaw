import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStoreMigrationRequiredError } from "../config/sessions/migration-required.js";
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
import * as directoryDurability from "../infra/directory-durability.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as migrationRun from "./doctor-session-sqlite-migration-run.js";
import { isSessionSqliteMigrationWarning } from "./doctor-session-sqlite-types.js";
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

afterEach(() => vi.restoreAllMocks());

describe("session sources needed by deferred plugin migrations", () => {
  it.each([
    { damage: "entry_invalid", interrupted: false },
    { damage: "transcript_malformed", interrupted: false },
    { damage: "both", interrupted: false },
    { damage: "transcript_malformed", interrupted: true },
  ])(
    "admits verified partial imports with $damage without replaying or retiring damaged history (archive interrupted: $interrupted)",
    async ({ damage, interrupted }) => {
      await withOpenClawTestState({ label: "deferred-damaged-session-source" }, async (state) => {
        const { cfg, storePath, originals, scope } = seedDeferredPluginSessionSource(
          state,
          "default",
        );
        const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
        if (damage !== "transcript_malformed") {
          const entries = JSON.parse(fs.readFileSync(storePath, "utf8"));
          entries["agent:main:invalid"] = { updatedAt: 20 };
          fs.writeFileSync(storePath, JSON.stringify(entries));
          originals.set(storePath, fs.readFileSync(storePath));
        }
        if (damage !== "entry_invalid") {
          fs.appendFileSync(transcript, '{broken\n{"type":"message","id":"unimported"}\n');
          originals.set(transcript, fs.readFileSync(transcript));
        }
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const imported = await run();
        expect(imported.totals.importedEntries).toBe(2);
        expect(imported.totals.importedTranscriptEvents).toBe(4);
        // This is the same readiness decision made by doctor --non-interactive --fix.
        expect(() =>
          assertSessionStoreMigrationComplete({ cfg, env: state.env, operation: "doctor" }),
        ).not.toThrow();
        const issues = imported.targets.flatMap((target) => target.issues);
        expect(issues.every(isSessionSqliteMigrationWarning)).toBe(true);
        for (const code of damage === "both"
          ? ["entry_invalid", "transcript_malformed"]
          : [damage]) {
          expect(issues).toContainEqual(expect.objectContaining({ code }));
        }
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }
        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "changed after partial import" },
        );
        await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        const retried = await run();
        expect(retried.totals.importedEntries).toBe(0);
        expect(
          retried.targets.flatMap((target) => target.issues).every(isSessionSqliteMigrationWarning),
        ).toBe(true);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after partial import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
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
          expect.objectContaining({
            code: damage === "entry_invalid" ? damage : "transcript_malformed",
          }),
        );
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        const moves = migrationRun
          .listSessionSqliteMigrationManifestPaths(state.env)
          .flatMap((file) => migrationRun.readSessionSqliteMigrationManifest(file)?.targets ?? [])
          .flatMap((target) => target.plannedMoves);
        for (const source of [storePath, ...(damage === "entry_invalid" ? [] : [transcript])]) {
          const move = moves.find((candidate) => candidate.sourcePath === source);
          expect(move?.artifact?.classification).toBe("protected");
          expect(fs.readFileSync(move!.archivePath)).toEqual(originals.get(source));
        }
      });
    },
  );

  it.each([
    { kind: "transcript", unusedAgent: false },
    { kind: "legacy-store", unusedAgent: false },
    { kind: "transcript", unusedAgent: true },
    { kind: "legacy-store", unusedAgent: true },
  ])(
    "retains an ordinary import's $kind when another Doctor records pending work before unlink (unused agent: $unusedAgent)",
    async ({ kind, unusedAgent }) => {
      await withOpenClawTestState({ label: "deferred-plugin-archive-race" }, async (state) => {
        const { cfg, storePath, originals, scope } = seedDeferredPluginSessionSource(
          state,
          unusedAgent ? "legacy-root" : "external",
        );
        const unusedDatabase = state.statePath("agents/ops/agent/openclaw-agent.sqlite");
        if (unusedAgent) {
          cfg.agents = { ...cfg.agents, entries: { ...cfg.agents?.entries, ops: {} } };
        }
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
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
              recordDeferredPluginMigrations({
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
        expect(readDeferredPluginMigrations({ env: state.env })).toEqual([
          expect.objectContaining({ pluginId: "fixture-plugin", requiresStateMigration: true }),
        ]);
        expect(interrupted.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({
            message: expect.stringContaining("Plugin migration obligations changed"),
          }),
        );

        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "edited after interrupted archival" },
        );
        await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        expect((await run()).totals.importedEntries).toBe(0);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("edited after interrupted archival");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(fs.readFileSync(protectedSource)).toEqual(originals.get(protectedSource));

        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
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
    {
      changeSource: false,
      siblingPending: false,
      pendingChange: "none",
      missingTranscript: "none",
    },
    { changeSource: true, siblingPending: false, pendingChange: "none", missingTranscript: "none" },
    {
      changeSource: "orphan",
      siblingPending: false,
      pendingChange: "none",
      missingTranscript: "absent",
    },
    { changeSource: false, siblingPending: true, pendingChange: "none", missingTranscript: "none" },
    {
      changeSource: false,
      siblingPending: false,
      pendingChange: "plugin",
      missingTranscript: "none",
    },
    {
      changeSource: false,
      siblingPending: false,
      pendingChange: "publication",
      missingTranscript: "none",
    },
    {
      changeSource: false,
      siblingPending: false,
      pendingChange: "none",
      missingTranscript: "absent",
    },
    {
      changeSource: false,
      siblingPending: false,
      pendingChange: "none",
      missingTranscript: "appears",
    },
  ])(
    "settles a retained source in the same Doctor after late plugin completion (source changed: $changeSource, sibling pending: $siblingPending, pending change: $pendingChange, missing transcript: $missingTranscript)",
    async ({ changeSource, siblingPending, pendingChange, missingTranscript }) => {
      await withOpenClawTestState({ label: "deferred-plugin-late-settlement" }, async (state) => {
        const {
          cfg: seededConfig,
          storePath,
          originals,
          scope,
        } = seedDeferredPluginSessionSource(
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
          recordDeferredPluginMigrations({
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
        await runDoctorSessionSqlite({
          cfg: seededConfig,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "changed after import" },
        );
        await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        const pluginRoot = state.path("fixture-plugin");
        const marker = state.path("late-migration-pending");
        const newHistoryId = missingTranscript === "appears" ? "legacy-missing" : "new-history";
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
          recordDeferredPluginMigrations({
            env: state.env,
            pending: [
              {
                pluginId: pendingChange === "plugin" ? "fixture-plugin" : "new-plugin",
                reason: "A concurrent Doctor found additional migration work.",
                command: "openclaw doctor --fix",
                requiresStateMigration: true,
              },
            ],
          });
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
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        if (pendingChange !== "none") {
          expect(pendingChanged).toBe(true);
          const pending = readDeferredPluginMigrations({ env: state.env });
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
          expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
            "Retained session migration source changed",
          );
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([
            expect.objectContaining({ pluginId: "fixture-plugin" }),
          ]);
          expect(fs.readFileSync(changedSource, "utf8")).toBe(
            originals.get(changedSource)?.toString() + (changeSource ? "\n" : ""),
          );
        } else if (siblingPending) {
          expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([
            expect.objectContaining({ pluginId: "waiting-plugin" }),
          ]);
          for (const [file, bytes] of originals) {
            expect(fs.readFileSync(file)).toEqual(bytes);
          }
        } else {
          expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([]);
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
    { layout: "external", missingTranscript: false },
    { layout: "default", missingTranscript: false },
    { layout: "legacy-root", missingTranscript: false },
    { layout: "legacy-root-with-unused-agent", missingTranscript: false },
    { layout: "default", missingTranscript: true },
    { layout: "relocated", missingTranscript: false },
    { layout: "relocated-interrupted", missingTranscript: false },
  ] as const)(
    "verifies canonical import and retains $layout originals until resolution without replay (missing transcript: $missingTranscript)",
    async ({ layout, missingTranscript }) => {
      await withOpenClawTestState({ label: "deferred-plugin-session-source" }, async (state) => {
        const { cfg, storePath, originals, scope } = seedDeferredPluginSessionSource(
          state,
          layout === "legacy-root-with-unused-agent"
            ? "legacy-root"
            : layout === "relocated" || layout === "relocated-interrupted"
              ? "default"
              : layout,
          "fixture-plugin",
          missingTranscript ? "declared" : undefined,
        );
        let foreignSource: { path: string; bytes: Buffer } | undefined;
        if (layout === "relocated" || layout === "relocated-interrupted") {
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
        const unusedDatabase = state.statePath("agents/ops/agent/openclaw-agent.sqlite");
        if (layout === "legacy-root-with-unused-agent") {
          cfg.agents = { ...cfg.agents, entries: { ...cfg.agents?.entries, ops: {} } };
          expect(fs.existsSync(unusedDatabase)).toBe(false);
        }
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
          "Legacy session store requires migration",
        );
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const imported = await run();
        if (layout === "legacy-root-with-unused-agent") {
          expect(fs.existsSync(unusedDatabase)).toBe(false);
        }
        expect(imported.totals.importedEntries).toBe(missingTranscript ? 3 : 2);
        expect(imported.targets.flatMap((target) => target.issues)).toEqual([
          ...(missingTranscript ? [expect.objectContaining({ code: "transcript_missing" })] : []),
          expect.objectContaining({ code: "plugin_migration_source_retained" }),
        ]);
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();

        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "changed after import" },
        );
        await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        expect((await run()).totals.importedEntries).toBe(0);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }

        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
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
        expect(resumed.targets.flatMap((target) => target.issues)).toEqual(
          missingTranscript ? [expect.objectContaining({ code: "transcript_missing" })] : [],
        );
        expect(fs.existsSync(storePath)).toBe(false);
        expect(resumed.totals.archivedTranscriptFiles).toBe(
          layout === "relocated-interrupted" ? 0 : 2,
        );
        if (missingTranscript) {
          const archives = migrationRun
            .listSessionSqliteMigrationManifestPaths(state.env)
            .flatMap(
              (manifestPath) =>
                migrationRun.readSessionSqliteMigrationManifest(manifestPath)?.targets ?? [],
            )
            .flatMap((target) => target.completedMoves)
            .filter((move) => move.sourcePath === storePath);
          expect(archives).toEqual([
            expect.objectContaining({
              artifact: expect.objectContaining({ classification: "protected" }),
            }),
          ]);
        }
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        if (foreignSource) {
          expect(fs.readFileSync(foreignSource.path)).toEqual(foreignSource.bytes);
        }
      });
    },
  );

  it("lets startup proceed for an empty index when the owner has no database yet", async () => {
    await withOpenClawTestState({ label: "deferred-empty-index-no-db" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
      const directory = state.sessionsDir("main");
      fs.mkdirSync(directory, { recursive: true });
      const storePath = path.join(directory, "sessions.json");
      fs.writeFileSync(storePath, "{}");
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
      // No owner can hold a replayable receipt without a database, and a
      // zero-record source has nothing to replay: startup must not demand one.
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      const report = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      expect(report.totals.importedEntries).toBe(0);
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        env: state.env,
      }).path;
      expect(fs.existsSync(sqlitePath)).toBe(false);
      expect(fs.readFileSync(storePath, "utf8")).toBe("{}");
    });
  });

  it.each(["unindexed history", "a removed receipt database"] as const)(
    "keeps startup blocked for an empty index with %s",
    async (kind) => {
      await withOpenClawTestState({ label: "deferred-empty-index-required" }, async (state) => {
        const cfg: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
        const directory = state.sessionsDir("main");
        fs.mkdirSync(directory, { recursive: true });
        const storePath = path.join(directory, "sessions.json");
        fs.writeFileSync(storePath, "{}");
        const scope = { agentId: "main", storePath, env: state.env };
        const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath, scope).path;
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
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
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
          await upsertSessionEntryCore(
            { ...scope, sessionKey: "agent:main:current" },
            { sessionId: "current", updatedAt: 1 },
          );
          const report = await run();
          expect(report.totals.importedEntries).toBe(0);
          expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
            expect.objectContaining({ code: "plugin_migration_source_retained" }),
          );
          expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
          closeOpenClawAgentDatabasesForTest();
          fs.unlinkSync(sqlitePath);
        }
        expect(fs.existsSync(sqlitePath)).toBe(false);
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
          kind === "unindexed history"
            ? SessionStoreMigrationRequiredError
            : expect.objectContaining({ code: "ENOENT", syscall: "lstat", path: sqlitePath }),
        );
        if (kind === "unindexed history") {
          const report = await run();
          expect(report.totals.importedEntries).toBe(1);
          expect(report.targets.flatMap((target) => target.issues)).toEqual([
            expect.objectContaining({ code: "plugin_migration_source_retained" }),
          ]);
          expect(
            loadExactSessionEntry({ ...scope, sessionKey: "agent:main:recovered:historical" })
              ?.entry.sessionId,
          ).toBe("historical");
          expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        }
        expect(fs.readFileSync(storePath, "utf8")).toBe("{}");
      });
    },
  );

  it.each(["unimported-owner", "unassigned", "retired-owner", "malformed", "unreadable"] as const)(
    "keeps readiness blocked for a retained source with %s state",
    async (kind) => {
      await withOpenClawTestState({ label: `deferred-readiness-${kind}` }, async (state) => {
        const { cfg, storePath } = seedDeferredPluginSessionSource(
          state,
          kind === "unimported-owner" ? "external" : "legacy-root",
        );
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
          const key =
            kind === "unimported-owner"
              ? "agent:ops:waiting"
              : kind === "retired-owner"
                ? "agent:retired:waiting"
                : "voice:unassigned";
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
          fs.existsSync(
            resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "ops", env: state.env })
              .path,
          ),
        ).toBe(false);
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
          "Legacy session store requires migration",
        );
        expect(fs.existsSync(storePath)).toBe(true);
      });
    },
  );

  it.each(["declared", "metadata-only"] as const)(
    "preserves a previously %s missing transcript that appears after verified import",
    async (kind) => {
      await withOpenClawTestState({ label: "deferred-transcript-appears" }, async (state) => {
        const { cfg, storePath, originals, scope } = seedDeferredPluginSessionSource(
          state,
          "default",
          "fixture-plugin",
          kind,
        );
        await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "current" },
        );
        const transcript = path.join(path.dirname(storePath), "legacy-missing.jsonl");
        const contents = '{"type":"session","version":3,"id":"legacy-missing"}\n';
        fs.writeFileSync(transcript, contents);
        const retry = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
        expect(retry.targets.flatMap((target) => target.issues)).toEqual([
          expect.objectContaining({ code: "retained_plugin_source_conflict" }),
        ]);
        expect(retry.totals.importedEntries).toBe(0);
        expect(retry.totals.archivedTranscriptFiles).toBe(0);
        expect(fs.readFileSync(transcript, "utf8")).toBe(contents);
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("current");
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
          "Retained session migration source changed",
        );
      });
    },
  );

  it("does not admit or replay a retained source changed after its verified import", async () => {
    await withOpenClawTestState({ label: "deferred-plugin-source-conflict" }, async (state) => {
      const { cfg, storePath, scope } = seedDeferredPluginSessionSource(state);
      await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:kept" },
        { label: "current" },
      );
      fs.appendFileSync(storePath, "\n");
      const retry = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      expect(retry.totals.importedEntries).toBe(0);
      expect(retry.targets.flatMap((target) => target.issues)).toEqual([
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      ]);
      expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
        "current",
      );
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
        "Retained session migration source changed",
      );
      expect(fs.existsSync(storePath)).toBe(true);
    });
  });
});
