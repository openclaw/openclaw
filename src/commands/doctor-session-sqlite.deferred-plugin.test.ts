import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { createPluginDoctorStateMigrationContext } from "../infra/state-migrations.plugin-doctor-context.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "./doctor-session-sqlite-migration-run.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { noteSessionTranscriptHealth } from "./doctor-session-transcripts.js";

afterEach(() => vi.restoreAllMocks());

function seed(
  state: OpenClawTestState,
  layout: "external" | "default" | "legacy-root" = "external",
  pluginId = "fixture-plugin",
) {
  const sessionsDir =
    layout === "external"
      ? path.join(state.root, "external-sessions")
      : layout === "default"
        ? state.sessionsDir("main")
        : state.statePath("sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const records = Object.fromEntries(
    ["kept", "deleted"].map((name) => {
      const sessionId = `legacy-${name}`;
      const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        transcript,
        [
          { type: "session", version: 3, id: sessionId },
          {
            type: "message",
            id: `${name}-message`,
            parentId: null,
            message: { role: "user", content: name },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      fs.writeFileSync(
        `${transcript}.${pluginId === "codex" ? "codex-app-server" : pluginId}.json`,
        JSON.stringify({
          schemaVersion: 2,
          threadId: name,
          sessionFile: transcript,
          updatedAt: "2026-01-01T00:00:00.000Z",
          pluginAppPolicyContext: { fingerprint: "policy-1", apps: {}, pluginAppIds: {} },
        }),
      );
      return [
        `agent:main:${name}`,
        { sessionId, sessionFile: path.basename(transcript), updatedAt: 20 },
      ];
    }),
  );
  fs.writeFileSync(storePath, JSON.stringify(records));
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { default: true } } },
    ...(layout === "external" ? { session: { store: storePath } } : {}),
  };
  recordDeferredPluginMigrations({
    env: state.env,
    pending: [
      {
        pluginId,
        reason: "The configured plugin is not installed.",
        command:
          pluginId === "codex"
            ? "openclaw plugins install @openclaw/codex"
            : "openclaw plugins install @example/fixture-plugin",
        ...(layout === "external" ? { configPaths: [["session", "store"]] } : {}),
      },
    ],
  });
  const originals = new Map(
    fs.readdirSync(sessionsDir).map((name) => {
      const file = path.join(sessionsDir, name);
      return [file, fs.readFileSync(file)];
    }),
  );
  const scope = {
    agentId: "main",
    env: state.env,
    storePath:
      layout === "legacy-root" ? path.join(state.sessionsDir("main"), "sessions.json") : storePath,
  };
  return { cfg, storePath, originals, scope };
}

describe("session sources needed by deferred plugin migrations", () => {
  it.each([
    { kind: "transcript", unusedAgent: false },
    { kind: "legacy-store", unusedAgent: false },
    { kind: "transcript", unusedAgent: true },
    { kind: "legacy-store", unusedAgent: true },
  ])(
    "retains an ordinary import's $kind when another Doctor records pending work before unlink (unused agent: $unusedAgent)",
    async ({ kind, unusedAgent }) => {
      await withOpenClawTestState({ label: "deferred-plugin-archive-race" }, async (state) => {
        const { cfg, storePath, originals, scope } = seed(
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
    { changeSource: false, siblingPending: false, pendingChange: "none" },
    { changeSource: true, siblingPending: false, pendingChange: "none" },
    { changeSource: false, siblingPending: true, pendingChange: "none" },
    { changeSource: false, siblingPending: false, pendingChange: "plugin" },
    { changeSource: false, siblingPending: false, pendingChange: "publication" },
  ])(
    "settles a retained source in the same Doctor after late plugin completion (source changed: $changeSource, sibling pending: $siblingPending, pending change: $pendingChange)",
    async ({ changeSource, siblingPending, pendingChange }) => {
      await withOpenClawTestState({ label: "deferred-plugin-late-settlement" }, async (state) => {
        const { cfg: seededConfig, storePath, originals, scope } = seed(state);
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
        const newHistory = path.join(path.dirname(storePath), "new-history.jsonl");
        const newHistoryBytes = '{"type":"session","version":3,"id":"new-history"}\n';
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
              ${changeSource ? `fs.appendFileSync(${JSON.stringify(storePath)}, "\\n");` : ""}
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
        } else if (changeSource) {
          expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
            "Retained session migration source changed",
          );
          expect(readDeferredPluginMigrations({ env: state.env })).toEqual([
            expect.objectContaining({ pluginId: "fixture-plugin" }),
          ]);
          expect(fs.readFileSync(storePath, "utf8")).toBe(
            originals.get(storePath)?.toString() + "\n",
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
          const archived = listSessionSqliteMigrationManifestPaths(state.env)
            .map((manifestPath) => readSessionSqliteMigrationManifest(manifestPath))
            .flatMap((manifest) => manifest?.targets ?? [])
            .filter((target) =>
              target.completedMoves.some((move) => move.sourcePath === storePath),
            );
          expect(archived).toEqual([
            expect.objectContaining({ validationBeforeArchive: "passed" }),
          ]);
          for (const file of originals.keys()) {
            if (file.endsWith(".jsonl")) {
              expect(fs.existsSync(file)).toBe(false);
            }
          }
        }
      });
    },
  );

  it.each(["external", "default", "legacy-root", "legacy-root-with-unused-agent"] as const)(
    "verifies canonical import and retains %s originals until resolution without replay",
    async (layout) => {
      await withOpenClawTestState({ label: "deferred-plugin-session-source" }, async (state) => {
        const { cfg, storePath, originals, scope } = seed(
          state,
          layout === "legacy-root-with-unused-agent" ? "legacy-root" : layout,
        );
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
        expect(imported.totals.importedEntries).toBe(2);
        expect(imported.targets.flatMap((target) => target.issues)).toEqual([
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
        const resumed = await run();
        expect(resumed.totals.importedEntries).toBe(0);
        expect(resumed.targets.flatMap((target) => target.issues)).toEqual([]);
        expect(fs.existsSync(storePath)).toBe(false);
        expect(resumed.totals.archivedTranscriptFiles).toBe(2);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      });
    },
  );

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
        expect(report.targets.flatMap((target) => target.issues)).toContainEqual(
          expect.objectContaining({ code: "plugin_migration_source_retained" }),
        );
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:current" })?.entry.sessionId,
        ).toBe("current");
        expect(fs.readFileSync(storePath, "utf8")).toBe("{}");
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
        const { cfg, storePath } = seed(
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

  it("does not admit or replay a retained source changed after its verified import", async () => {
    await withOpenClawTestState({ label: "deferred-plugin-source-conflict" }, async (state) => {
      const { cfg, storePath, scope } = seed(state);
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

describe("resumed Codex session binding migration", () => {
  async function migration() {
    const contract = await loadBundledPluginFacade<{
      stateMigrations: PluginDoctorStateMigration[];
    }>({ pluginId: "codex", artifactBasename: "doctor-contract-api.js" });
    const sidecars = contract.stateMigrations.find(
      (entry) => entry.id === "codex-app-server-sidecars-to-plugin-state",
    );
    if (!sidecars) {
      throw new Error("Codex sidecar migration is missing from its public Doctor contract");
    }
    return sidecars;
  }

  it.each(["before", "during"] as const)(
    "honors canonical deletion %s actual plugin migration after deferred import",
    async (timing) => {
      await withOpenClawTestState({ label: `codex-deferred-deletion-${timing}` }, async (state) => {
        const { cfg, scope, originals } = seed(state, "default", "codex");
        await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const remove = () =>
          deleteSessionEntryLifecycle({
            ...scope,
            target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
          });
        if (timing === "before") {
          expect((await remove()).deleted).toBe(true);
        }
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          config: cfg,
          env: state.env,
        });
        let deletedDuringMigration = false;
        const migrationContext: typeof context =
          timing === "before"
            ? context
            : {
                ...context,
                openPluginStateKeyedStore<T>(
                  options: Parameters<typeof context.openPluginStateKeyedStore>[0],
                ) {
                  const store = context.openPluginStateKeyedStore<T>(options);
                  return {
                    ...store,
                    async registerIfAbsent(...args: Parameters<typeof store.registerIfAbsent>) {
                      const registered = await store.registerIfAbsent(...args);
                      const binding = args[1];
                      if (
                        !deletedDuringMigration &&
                        isRecord(binding) &&
                        binding.sessionId === "legacy-deleted"
                      ) {
                        deletedDuringMigration = true;
                        expect((await remove()).deleted).toBe(true);
                      }
                      return registered;
                    },
                  };
                },
              };
        const params = {
          config: cfg,
          env: state.env,
          stateDir: state.stateDir,
          oauthDir: state.statePath("oauth"),
          context: migrationContext,
        };
        const result = await (await migration()).migrateLegacyState(params);
        expect(result.warnings).toEqual([]);
        if (timing === "during") {
          expect(deletedDuringMigration).toBe(true);
        }
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.agentHarnessId,
        ).toBe("codex");
        const readBindings = context.readPluginStateEntriesInKeyRange;
        if (!readBindings) {
          throw new Error("Doctor context must provide read-only plugin state inspection");
        }
        const bindings = readBindings("app-server-thread-bindings", {
          prefix: "session",
          limit: 100,
        });
        expect(bindings).toContainEqual(
          expect.objectContaining({
            value: expect.objectContaining({ sessionId: "legacy-kept", state: "active" }),
          }),
        );
        expect(
          bindings.filter(
            (entry) =>
              isRecord(entry.value) &&
              entry.value.sessionId === "legacy-deleted" &&
              entry.value.state === "active",
          ),
        ).toEqual([]);
        for (const file of originals.keys()) {
          if (file.endsWith(".codex-app-server.json")) {
            expect(fs.existsSync(file)).toBe(false);
          }
        }
        expect(await (await migration()).detectLegacyState(params)).toBeNull();
      });
    },
  );

  it.each(["default", "legacy-root"] as const)(
    "does not resurrect an imported session because an unrelated %s source is unimported",
    async (layout) => {
      await withOpenClawTestState({ label: `codex-mixed-source-${layout}` }, async (state) => {
        const { cfg, scope } = seed(state, "external", "codex");
        await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const directory =
          layout === "default" ? state.sessionsDir("main") : state.statePath("sessions");
        fs.mkdirSync(directory, { recursive: true });
        const unrelatedStore = path.join(directory, "sessions.json");
        const unrelatedSource = JSON.stringify({
          "agent:main:not-imported": {
            sessionId: "not-imported",
            sessionFile: "not-imported.jsonl",
            updatedAt: 1,
          },
        });
        fs.writeFileSync(unrelatedStore, unrelatedSource);
        expect(
          (
            await deleteSessionEntryLifecycle({
              ...scope,
              target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
              archiveTranscript: false,
              deleteTranscriptWithoutArchive: true,
            })
          ).deleted,
        ).toBe(true);
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          config: cfg,
          env: state.env,
        });
        const result = await (
          await migration()
        ).migrateLegacyState({
          config: cfg,
          env: state.env,
          stateDir: state.stateDir,
          oauthDir: state.statePath("oauth"),
          context,
        });
        expect(result.warnings).toEqual([]);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(
          await context.readSessionIdentityEvidenceBatch?.([
            { agentId: "main", sessionId: "legacy-deleted" },
            { agentId: "main", sessionId: "not-imported" },
          ]),
        ).toEqual([
          { agentId: "main", sessionId: "legacy-deleted", state: "absent" },
          { agentId: "main", sessionId: "not-imported", state: "unknown" },
        ]);
        expect(fs.readFileSync(unrelatedStore, "utf8")).toBe(unrelatedSource);
      });
    },
  );

  it("still imports a first legacy binding when canonical state exists but its source was never imported", async () => {
    await withOpenClawTestState({ label: "codex-first-sidecar-import" }, async (state) => {
      const { cfg, scope } = seed(state, "default", "codex");
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated", updatedAt: 1 },
      );
      const context = createPluginDoctorStateMigrationContext({
        pluginId: "codex",
        config: cfg,
        env: state.env,
      });
      const result = await (
        await migration()
      ).migrateLegacyState({
        config: cfg,
        env: state.env,
        stateDir: state.stateDir,
        oauthDir: state.statePath("oauth"),
        context,
      });
      expect(result.warnings).toEqual([]);
      expect(
        loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.agentHarnessId,
      ).toBe("codex");
      expect(
        loadExactSessionEntry({ ...scope, sessionKey: "agent:main:unrelated" })?.entry.sessionId,
      ).toBe("unrelated");
    });
  });
});
