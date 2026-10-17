import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { runPluginDoctorStateMigrationPlans } from "../infra/state-migrations.plugin-doctor.js";
import type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationEntry,
} from "../plugins/doctor-contract-module.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { assertDatabasePortPluginMigrationsComplete } from "./doctor-database-port-migrations.js";
import { doctorDatabasePort } from "./doctor-database-port.js";

const controls = vi.hoisted(() => ({ entries: [] as PluginDoctorStateMigrationEntry[] }));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorStateMigrationEntries: () => controls.entries,
}));

afterEach(() => {
  controls.entries = [];
});

describe("database port legacy import preflight", () => {
  it.each([
    { pluginId: "codex", id: "codex-native-task-assignments" },
    { pluginId: "matrix", id: "matrix-inbound-dedupe-to-claimable-dedupe" },
  ])(
    "preserves pending $pluginId SQLite input until its real Doctor migration completes",
    async ({ pluginId, id }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const { stateMigrations } = (await import(
          /* @vite-ignore */ new URL(
            `../../extensions/${pluginId}/doctor-contract-api.ts`,
            import.meta.url,
          ).href
        )) as { stateMigrations: PluginDoctorStateMigration[] };
        const migration = stateMigrations.find((entry) => entry.id === id);
        expect(migration).toBeDefined();
        if (!migration) {
          throw new Error(`Missing ${id}`);
        }
        controls.entries = [
          { pluginId, channelIds: pluginId === "matrix" ? ["matrix"] : [], migration },
        ];
        const config: OpenClawConfig = {
          database: {
            engine: "sqlite",
            postgres: { connection: "postgres://unused.invalid/test" },
          },
          plugins: { enabled: false },
        };
        await state.writeConfig(config);
        let source: string;
        if (pluginId === "codex") {
          const { db } = openOpenClawStateDatabase({ env: state.env });
          db.prepare(`INSERT INTO task_runs (
          task_id, runtime, task_kind, source_id, requester_session_key, owner_key,
          scope_kind, agent_id, requester_agent_id, run_id, task, status,
          delivery_status, notify_policy, created_at, ended_at, terminal_summary, detail_json
        ) VALUES ('retained-task', 'subagent', 'codex-native', 'source', 'agent:main:parent',
          'agent:main:parent', 'session', 'main', 'main', 'codex-thread:child:turn:turn',
          'Synthetic retained task', 'succeeded', 'pending', 'silent', 100, 200,
          'Retained result', ?)`).run(
            JSON.stringify({
              nativeHistory: {
                parentThreadId: "parent",
                sessionId: "retired-session",
                lifecycleRevision: "retired-revision",
                connectionFingerprint: "a".repeat(64),
              },
            }),
          );
          await closeOpenClawStateDatabaseAsync();
          source = state.statePath("state", "openclaw.sqlite");
        } else {
          source = state.statePath(
            "matrix",
            "accounts",
            "default",
            "matrix.example.org__bot",
            "0123456789abcdef",
            "state",
            "openclaw.sqlite",
          );
          await fs.mkdir(path.dirname(source), { recursive: true });
          const roomId = "!room:example.org",
            eventId = "$retained-event",
            ts = Date.now();
          const key = `default:${createHash("sha256").update(`default\0${roomId}\0${eventId}`).digest("hex")}`;
          using db = new DatabaseSync(source);
          db.exec(`CREATE TABLE plugin_state_entries (
          plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL,
          value_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
          PRIMARY KEY (plugin_id, namespace, entry_key)
        ) STRICT; PRAGMA user_version = 1;`);
          db.prepare(
            "INSERT INTO plugin_state_entries VALUES ('matrix', 'inbound-dedupe', ?, ?, ?, NULL)",
          ).run(key, JSON.stringify({ roomId, eventId, ts }), ts);
        }
        const before = await fs.readFile(source);
        const gate = () =>
          assertDatabasePortPluginMigrationsComplete({
            config,
            env: state.env,
            stateDir: state.stateDir,
            to: "postgres",
          });
        await expect(gate()).rejects.toThrow(`${pluginId}/${id}`);
        expect(await fs.readFile(source)).toEqual(before);
        const skipped = await runPluginDoctorStateMigrationPlans({
          detected: {
            stateDir: state.stateDir,
            oauthDir: state.statePath("oauth"),
            doctorOnlyStateMigrations: true,
          },
          config: { ...config, database: { ...config.database, engine: "postgres" } },
          env: state.env,
        });
        expect(skipped.changes).toEqual([]);
        expect(skipped.warnings).toEqual([]);
        expect(skipped.notices).toEqual([
          `${migration.label}: legacy SQLite migration not applicable on PostgreSQL; legacy data is migrated before port.`,
        ]);
        expect(await fs.readFile(source)).toEqual(before);
        const repaired = await runPluginDoctorStateMigrationPlans({
          detected: {
            stateDir: state.stateDir,
            oauthDir: state.statePath("oauth"),
            doctorOnlyStateMigrations: true,
          },
          config,
          env: state.env,
        });
        expect(repaired.warnings).toEqual([]);
        expect(repaired.changes.length).toBeGreaterThan(0);
        await expect(gate()).resolves.toBeUndefined();
        await closeOpenClawStateDatabaseAsync();
      });
    },
  );

  it("refuses before port preparation and permits retry after the source migration completes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config: OpenClawConfig = {
        database: { engine: "sqlite", postgres: { connection: "postgres://unused.invalid/test" } },
        plugins: { enabled: false },
      };
      await state.writeConfig(config);
      const source = state.path("legacy.sqlite");
      {
        using db = new DatabaseSync(source);
        db.exec("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('pending')");
      }
      const migrateLegacyState = vi.fn(() => ({ changes: [], warnings: [] }));
      controls.entries = [
        {
          pluginId: "legacy-owner",
          channelIds: [],
          migration: {
            id: "legacy-import",
            label: "Legacy data",
            sqliteOnly: { family: "workboard" },
            doctorOnly: true,
            phase: "after-session-repair",
            detectLegacyState: () => {
              using db = new DatabaseSync(source, { readOnly: true });
              return db.prepare("SELECT 1 FROM legacy").get()
                ? { preview: ["Legacy data needs import"] }
                : null;
            },
            migrateLegacyState,
          },
        },
      ];
      const before = await fs.readFile(source);
      const configBefore = await fs.readFile(state.configPath);
      for (const family of [undefined, "workboard"] as const) {
        await expect(doctorDatabasePort({ family, to: "postgres" })).rejects.toThrow(
          "legacy-owner/legacy-import (Legacy data). Run openclaw doctor --fix first, then retry port.",
        );
      }
      await expect(
        doctorDatabasePort({ family: "state", to: "postgres", dryRun: true }),
      ).resolves.toMatchObject({ phase: "preflight" });
      expect(await fs.readFile(source)).toEqual(before);
      expect(await fs.readFile(state.configPath)).toEqual(configBefore);
      await expect(
        fs.stat(state.statePath("recovery", "database-port", "manifest.json")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(migrateLegacyState).not.toHaveBeenCalled();
      {
        using db = new DatabaseSync(source);
        db.exec("DELETE FROM legacy");
      }
      await expect(
        assertDatabasePortPluginMigrationsComplete({
          config,
          env: state.env,
          stateDir: state.stateDir,
          to: "postgres",
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("detects only families whose effective engine moves from SQLite to PostgreSQL", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const detected: string[] = [];
      controls.entries = (["state", "agent", "workboard", "logbook", "team-reports"] as const).map(
        (family) => ({
          pluginId: family,
          channelIds: [],
          migration: {
            id: `${family}-import`,
            label: family,
            sqliteOnly: { family },
            detectLegacyState: () => {
              detected.push(family);
              return null;
            },
            migrateLegacyState: () => {
              throw new Error("port must never run Doctor migrations");
            },
          },
        }),
      );
      await assertDatabasePortPluginMigrationsComplete({
        config: {
          database: {
            engine: "sqlite",
            families: { state: { engine: "postgres" }, agent: { engine: "sqlite" } },
          },
        },
        env: state.env,
        stateDir: state.stateDir,
        to: "postgres",
      });
      expect(detected).toEqual(["workboard", "logbook", "team-reports"]);
      detected.length = 0;
      await assertDatabasePortPluginMigrationsComplete({
        config: { database: { engine: "sqlite" } },
        env: state.env,
        stateDir: state.stateDir,
        to: "postgres",
        family: "workboard",
      });
      expect(detected).toEqual(["workboard"]);
      detected.length = 0;
      await assertDatabasePortPluginMigrationsComplete({
        config: { database: { engine: "postgres" } },
        env: state.env,
        stateDir: state.stateDir,
        to: "sqlite",
      });
      expect(detected).toEqual([]);
    });
  });

  it("fails closed without exposing detector errors", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      controls.entries = [
        {
          pluginId: "source-owner",
          channelIds: [],
          migration: {
            id: "unreadable-import",
            label: "Unreadable legacy data",
            sqliteOnly: { family: "state" },
            detectLegacyState: () => {
              throw new Error("private legacy payload");
            },
            migrateLegacyState: () => ({ changes: [], warnings: [] }),
          },
        },
      ];
      await expect(
        assertDatabasePortPluginMigrationsComplete({
          config: {},
          env: state.env,
          stateDir: state.stateDir,
          to: "postgres",
        }),
      ).rejects.toThrow(
        "Database port could not inspect SQLite migration source-owner/unreadable-import (Unreadable legacy data). Run openclaw doctor --fix first, then retry port.",
      );
    });
  });
});
