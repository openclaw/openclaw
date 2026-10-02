import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "./deferred-plugin-migrations.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";
import * as mutationAdmission from "./sqlite-worker-operation-admission.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import {
  runPluginDoctorStateMigrationPlans,
  runPostSessionPluginDoctorStateRepairs,
} from "./state-migrations.plugin-doctor.js";

describe("plugin doctor ingress authority", () => {
  it("rolls back a queued claim when the repair owner expires before native commit", async () => {
    await withOpenClawTestState(
      { label: "doctor-ingress-commit", applyEnv: false },
      async ({ env, stateDir }) => {
        let active = true;
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "line",
          env,
          config: {},
          channelIngress: {
            channelIds: ["line"],
            stateDir,
            mutation: {
              assertCurrent() {
                if (!active) {
                  throw new Error("repair owner expired");
                }
              },
            },
          },
        });
        const queue = context.channelIngressQueues?.[0]?.openChannelIngressQueue?.();
        if (!queue) {
          throw new Error("Missing Doctor repair queue");
        }
        await queue.enqueue("pending", { text: "retained" });
        const createAdmission = mutationAdmission.createSqliteWorkerOperationAdmission;
        const observer = vi
          .spyOn(mutationAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === "commit") {
                active = false;
              }
              admit(request, grant);
            }, attachment),
          );
        try {
          const outcome = await queue.claim("pending").then(
            () => undefined,
            (error: unknown) => error,
          );
          const reader = createChannelIngressQueue({ channelId: "line", stateDir });
          expect((await reader.listPending()).map((row) => row.id)).toEqual(["pending"]);
          expect(await reader.listClaims()).toEqual([]);
          expect(outcome).toMatchObject({
            message: expect.stringContaining("repair owner expired"),
          });
        } finally {
          observer.mockRestore();
        }
      },
    );
  });
});

describe("plugin doctor session identity evidence", () => {
  it("preserves two current keys sharing an identity instead of inventing a main owner", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-shared-id", applyEnv: false },
      async ({ env }) => {
        for (const sessionKey of ["agent:main:main", "agent:main:other"]) {
          await replaceSessionEntry(
            { agentId: "main", env, sessionKey },
            { sessionId: "shared-id", updatedAt: 1 },
          );
        }
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          env,
          config: {},
        });

        await expect(
          context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "shared-id" }]),
        ).resolves.toEqual([{ agentId: "main", sessionId: "shared-id", state: "unknown" }]);
      },
    );
  });

  it.each(["per-agent", "fixed"] as const)(
    "proves absence from an initialized empty %s session store",
    async (kind) => {
      await withOpenClawTestState(
        { label: `plugin-doctor-empty-${kind}`, applyEnv: false },
        async ({ env, root }) => {
          const fixedStorePath = path.join(root, "fixed.sqlite");
          const config: OpenClawConfig =
            kind === "fixed" ? { session: { store: fixedStorePath } } : {};
          openOpenClawAgentDatabase({
            agentId: "main",
            env,
            ...(kind === "fixed" ? { path: fixedStorePath } : {}),
          });
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "codex",
            env,
            config,
          });

          await expect(
            context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "gone" }]),
          ).resolves.toEqual([{ agentId: "main", sessionId: "gone", state: "absent" }]);
          expect(context.deletePluginStateEntriesIfUnchanged).toBeUndefined();
        },
      );
    },
  );

  it.each(["missing", "broken"] as const)(
    "keeps a %s session store unknown rather than proving absence",
    async (kind) => {
      await withOpenClawTestState(
        { label: `plugin-doctor-${kind}`, applyEnv: false },
        async ({ env }) => {
          if (kind === "broken") {
            openOpenClawAgentDatabase({ agentId: "main", env }).db.exec(
              "PRAGMA user_version = 999",
            );
          }
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "codex",
            env,
            config: {},
          });

          await expect(
            context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "gone" }]),
          ).resolves.toEqual([{ agentId: "main", sessionId: "gone", state: "unknown" }]);
        },
      );
    },
  );

  it.each(["malformed", "mismatched-identity"] as const)(
    "keeps %s fixed-store rows unknown instead of treating them as empty",
    async (corruption) => {
      await withOpenClawTestState(
        { label: `plugin-doctor-fixed-${corruption}`, applyEnv: false },
        async ({ env, root }) => {
          const storePath = path.join(root, "fixed.sqlite");
          const sessionKey = "agent:main:broken";
          await replaceSessionEntry(
            { agentId: "main", env, sessionKey, storePath },
            { sessionId: "broken-session", updatedAt: 1 },
          );
          const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath }).db;
          if (corruption === "malformed") {
            database
              .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
              .run("{broken", sessionKey);
          } else {
            database
              .prepare("UPDATE session_nodes SET current_session_id = ? WHERE session_key = ?")
              .run("wrong-session", sessionKey);
          }
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "codex",
            env,
            config: { session: { store: storePath } },
          });

          const sessionId = corruption === "malformed" ? "broken-session" : "wrong-session";
          await expect(
            context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId }]),
          ).resolves.toEqual([{ agentId: "main", sessionId, state: "unknown" }]);
        },
      );
    },
  );

  it("resolves the authoritative canonical session key using the Doctor-owned environment", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-current", applyEnv: false },
      async ({ env, root }) => {
        const storePath = path.join(root, "fixed.sqlite");
        const sessionKey = "agent:main:renamed";
        await replaceSessionEntry(
          { agentId: "main", env, sessionKey, storePath },
          { sessionId: "live", updatedAt: 1 },
        );
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          env,
          config: { session: { store: storePath } },
        });

        const requests = [
          { agentId: "main", sessionId: "live" },
          { agentId: "main", sessionId: "gone" },
          { agentId: "main", sessionId: "live" },
        ];
        await expect(context.readSessionIdentityEvidenceBatch?.([])).resolves.toEqual([]);
        await expect(context.readSessionIdentityEvidenceBatch?.(requests)).resolves.toEqual([
          { agentId: "main", sessionId: "live", state: "current", sessionKey },
          { agentId: "main", sessionId: "gone", state: "absent" },
          { agentId: "main", sessionId: "live", state: "current", sessionKey },
        ]);

        // Discovery may be cached within a context; row evidence must be read anew.
        await replaceSessionEntry(
          { agentId: "main", env, sessionKey, storePath },
          { sessionId: "gone", updatedAt: 2 },
        );
        await expect(context.readSessionIdentityEvidenceBatch?.(requests)).resolves.toEqual([
          { agentId: "main", sessionId: "live", state: "absent" },
          { agentId: "main", sessionId: "gone", state: "current", sessionKey },
          { agentId: "main", sessionId: "live", state: "absent" },
        ]);
      },
    );
  });

  it("deduplicates configured SQLite and discovered JSON aliases by physical owner", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-physical-alias", applyEnv: false },
      async ({ env, stateDir }) => {
        const agentRoot = path.join(stateDir, "agents", "main");
        const storePath = path.join(agentRoot, "agent", "openclaw-agent.sqlite");
        fs.mkdirSync(path.join(agentRoot, "sessions"), { recursive: true });
        const sessionKey = "agent:main:renamed";
        await replaceSessionEntry(
          { agentId: "main", env, sessionKey, storePath },
          { sessionId: "live", updatedAt: 1 },
        );
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          env,
          config: {
            session: {
              store: path.join(stateDir, "agents", "{agentId}", "agent", "openclaw-agent.sqlite"),
            },
          },
        });

        await expect(
          context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "live" }]),
        ).resolves.toEqual([{ agentId: "main", sessionId: "live", state: "current", sessionKey }]);
      },
    );
  });

  it("rejects retained destructive repair callbacks after their owner expires", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-expired-repair", applyEnv: false },
      async ({ env }) => {
        let active = true;
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          env,
          config: {},
          repairAuthority: {
            assertCurrent() {
              if (!active) {
                throw new Error("repair owner expired");
              }
            },
            assertOwnedInTransaction() {},
          },
        });
        const options = { namespace: "doctor-repair", maxEntries: 10 };
        const store = context.openPluginStateKeyedStore<{ sessionId: string }>(options);
        await store.register("binding:retained", { sessionId: "gone" });
        const observed = context.readPluginStateEntriesInKeyRange?.(options.namespace, {
          prefix: "binding:",
          limit: 10,
        });
        expect(observed).toHaveLength(1);

        active = false;

        expect(() =>
          context.deletePluginStateEntriesIfUnchanged?.(options.namespace, observed ?? []),
        ).toThrow("repair owner expired");
        expect(() =>
          context.readPluginStateEntriesInKeyRange?.(options.namespace, {
            prefix: "binding:",
            limit: 10,
          }),
        ).toThrow("repair owner expired");
        await expect(
          context.readSessionIdentityEvidenceBatch?.([{ agentId: "main", sessionId: "gone" }]),
        ).rejects.toThrow("repair owner expired");
        await expect(store.lookup("binding:retained")).resolves.toEqual({ sessionId: "gone" });
      },
    );
  });

  it("revokes retained ingress purge after Doctor repair authority expires", async () => {
    await withOpenClawTestState(
      { label: "plugin-doctor-expired-purge", applyEnv: false },
      async ({ env, stateDir }) => {
        let active = true;
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "migration-fixture",
          env,
          config: {},
          channelIngress: {
            channelIds: ["migration-fixture"],
            stateDir,
            mutation: {
              assertCurrent() {
                if (!active) {
                  throw new Error("repair owner expired");
                }
              },
            },
          },
        });
        const ingress = context.channelIngressQueues?.[0];
        const queue = ingress?.openChannelIngressQueue?.<string>();
        const inspection = ingress?.openChannelIngressQueueForInspection<string>();
        const purge = queue?.purge?.bind(queue);
        if (!queue || !purge || !inspection) {
          throw new Error("Doctor repair did not provide ingress purge");
        }

        await queue.enqueue("authorized", "inside repair");
        await expect(purge()).resolves.toBe(1);
        await expect(queue.listPending()).resolves.toEqual([]);

        await queue.enqueue("retained", "must survive expired repair");
        active = false;

        await expect(Promise.resolve().then(() => purge())).rejects.toThrow("repair owner expired");
        expect((await inspection.listPending()).map((entry) => entry.id)).toEqual(["retained"]);
      },
    );
  });
});

describe("Telegram registered SQLite offset repair", () => {
  const namespace = "telegram.update-offsets";
  const config: OpenClawConfig = {
    plugins: { allow: ["telegram"] },
    channels: { telegram: { enabled: true } },
  };
  const pending = [
    {
      pluginId: "telegram",
      requiresStateMigration: true as const,
      reason: "offset repair pending",
      command: "openclaw doctor --fix",
    },
  ];

  const originals = [
    {
      key: "first",
      raw: '{ "version": 1, "lastUpdateId": 777, "extra": ["kept"] }',
      createdAt: 11,
      expiresAt: null,
    },
    {
      key: "second",
      raw: '{ "version": 2, "lastUpdateId": 999, "botId": "111111" }',
      createdAt: 12,
      expiresAt: 8_000_000_000_000,
    },
  ];
  function seed(db: DatabaseSync) {
    for (const row of originals) {
      db.prepare(
        "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("telegram", namespace, row.key, row.raw, row.createdAt, row.expiresAt);
    }
  }
  function rows(db: DatabaseSync) {
    return db
      .prepare(
        "SELECT entry_key, value_json, created_at, expires_at FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ? ORDER BY entry_key",
      )
      .all("telegram", namespace);
  }
  async function registeredMigration() {
    const contract = await loadBundledPluginFacade<{
      stateMigrations: PluginDoctorStateMigration[];
    }>({ pluginId: "telegram", artifactBasename: "doctor-contract-api.js" });
    const migration = contract.stateMigrations.find(({ id }) => id === "telegram-update-offsets");
    if (!migration) {
      throw new Error("Missing registered Telegram offset migration");
    }
    return migration;
  }

  it("backs up exact originals and normalizes once without binding credentials or changing row age", async () => {
    await withOpenClawTestState(
      { label: "telegram-offset-doctor", applyEnv: false },
      async ({ env, stateDir }) => {
        const { db } = openOpenClawStateDatabase({ env });
        seed(db);
        const before = rows(db);
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "telegram",
          env,
          config: {},
          repairAuthority: {
            assertCurrent() {},
            assertOwnedInTransaction(database) {
              expect(database.isTransaction).toBe(true);
            },
          },
        });
        const migration = await registeredMigration();
        const input = {
          config: {},
          env,
          stateDir,
          oauthDir: path.join(stateDir, "credentials"),
          context,
        };
        expect(await migration.detectLegacyState(input)).not.toBeNull();
        await recordDeferredPluginMigrations({ env, pending });
        const earlier = await runPluginDoctorStateMigrationPlans({
          config,
          env,
          detected: { stateDir, oauthDir: input.oauthDir, doctorOnlyStateMigrations: true },
        });
        expect(earlier.completedPluginIds ?? []).not.toContain("telegram");
        expect(readDeferredPluginMigrations({ env })).toEqual(pending);
        const result = await withDoctorSqliteMaintenanceLock({
          env,
          operation: "telegram-offset-test",
          run: (maintenanceAuthority) =>
            runPostSessionPluginDoctorStateRepairs({
              env,
              config,
              maintenanceAuthority,
            }),
        });
        expect(result.warnings).toEqual([]);
        expect(readDeferredPluginMigrations({ env })).toEqual([]);
        const backupPath = result.changes
          .find((line) => line.startsWith("Saved pre-migration SQLite backup: "))
          ?.split(": ")[1];
        if (!backupPath) {
          throw new Error("Missing verified pre-repair backup");
        }
        const backup = openNodeSqliteDatabase(backupPath, { readOnly: true });
        try {
          expect(rows(backup)).toEqual(before);
        } finally {
          backup.close();
        }
        expect(rows(db)).toEqual([
          {
            entry_key: "first",
            value_json: JSON.stringify({
              version: 3,
              lastUpdateId: 777,
              extra: ["kept"],
              botId: null,
              tokenFingerprint: null,
            }),
            created_at: 11,
            expires_at: null,
          },
          {
            entry_key: "second",
            value_json: JSON.stringify({
              version: 3,
              lastUpdateId: 999,
              botId: "111111",
              tokenFingerprint: null,
            }),
            created_at: 12,
            expires_at: 8_000_000_000_000,
          },
        ]);
        expect(await migration.detectLegacyState(input)).toBeNull();
        expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
      },
    );
  });

  it.each([
    { raw: '{"version":1,"lastUpdateId":"777"}', padding: 511 },
    { raw: '{"version":1,"lastUpdateId":-1}', padding: 0 },
    { raw: '{"version":2,"lastUpdateId":777,"botId":{}}', padding: 0 },
  ])("leaves malformed durable offsets pending: $raw", async ({ raw, padding }) => {
    await withOpenClawTestState(
      { label: "telegram-offset-malformed", applyEnv: false },
      async ({ env }) => {
        const { db } = openOpenClawStateDatabase({ env });
        seed(db);
        db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = 'second'").run(
          raw,
        );
        db.exec("BEGIN");
        try {
          const insert = db.prepare(
            "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
          );
          for (let index = 0; index < padding; index++) {
            insert.run("telegram", namespace, `middle-${index}`, originals[0].raw, 11, null);
          }
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        const before = rows(db);
        await recordDeferredPluginMigrations({ env, pending });
        const result = await withDoctorSqliteMaintenanceLock({
          env,
          operation: "telegram-offset-malformed-test",
          run: (maintenanceAuthority) =>
            runPostSessionPluginDoctorStateRepairs({ env, config, maintenanceAuthority }),
        });
        expect(result.warnings.join("\n")).toContain(
          'account "second" is malformed; restore its known-good state backup',
        );
        expect(result.changes).toEqual([]);
        expect(rows(db)).toEqual(before);
        expect(readDeferredPluginMigrations({ env })).toEqual(pending);
      },
    );
  });

  it("refuses unsupported inspection instead of certifying empty Telegram state", async () => {
    await withOpenClawTestState(
      { label: "telegram-offset-unsupported", applyEnv: false },
      async ({ env, stateDir }) => {
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "telegram",
          env,
          config,
        });
        delete context.readPluginStateEntriesInKeyRange;
        const migration = await registeredMigration();
        const input = {
          config,
          env,
          stateDir,
          oauthDir: path.join(stateDir, "credentials"),
          context,
        };
        expect(() => migration.detectLegacyState(input)).toThrow(
          "Update OpenClaw before inspecting Telegram SQLite offsets",
        );
        await expect(migration.migrateLegacyState(input)).rejects.toThrow(
          "Update OpenClaw before inspecting Telegram SQLite offsets",
        );
      },
    );
  });

  it("keeps Telegram pending when its registered after-session repair loses authority", async () => {
    await withOpenClawTestState(
      { label: "telegram-offset-pending", applyEnv: false },
      async ({ env }) => {
        const { db } = openOpenClawStateDatabase({ env });
        seed(db);
        await recordDeferredPluginMigrations({ env, pending });
        let active = true;
        const createSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
        const interception = vi
          .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
          .mockImplementation(async (options) => {
            const backup = await createSnapshot(options);
            active = false;
            return backup;
          });
        try {
          const result = await withDoctorSqliteMaintenanceLock({
            env,
            operation: "telegram-offset-pending-test",
            run: (authority) =>
              runPostSessionPluginDoctorStateRepairs({
                env,
                config,
                maintenanceAuthority: {
                  assertCurrent() {
                    authority.assertCurrent();
                    if (!active) {
                      throw new Error("repair owner expired");
                    }
                  },
                },
              }),
          });
          expect(result.warnings.join("\n")).toContain("repair owner expired");
          expect(readDeferredPluginMigrations({ env })).toEqual(pending);
          expect(rows(db)[0]).toMatchObject({ value_json: originals[0].raw });
        } finally {
          interception.mockRestore();
        }
      },
    );
  });

  it.each(["row", "generation"] as const)(
    "refuses a changed %s after backup without partially normalizing",
    async (change) => {
      await withOpenClawTestState(
        { label: `telegram-offset-${change}`, applyEnv: false },
        async ({ env, stateDir }) => {
          const database = openOpenClawStateDatabase({ env });
          seed(database.db);
          const assertCurrent = () => {};
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "telegram",
            env,
            config: {},
            repairAuthority: { assertCurrent, assertOwnedInTransaction: assertCurrent },
          });
          const migration = await registeredMigration();
          const createSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
          const interception = vi
            .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
            .mockImplementation(async (options) => {
              const backup = await createSnapshot(options);
              if (change === "row") {
                database.db
                  .prepare(
                    "UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = 'second'",
                  )
                  .run('{"version":3,"lastUpdateId":123,"botId":null,"tokenFingerprint":null}');
              }
              if (change === "generation") {
                await closeOpenClawStateDatabaseAsync();
                fs.renameSync(database.path, `${database.path}.original`);
                fs.copyFileSync(backup.path, database.path);
              }
              return backup;
            });
          try {
            await expect(
              migration.migrateLegacyState({
                config: {},
                env,
                stateDir,
                oauthDir: path.join(stateDir, "credentials"),
                context,
              }),
            ).rejects.toThrow(
              change === "row" ? /Plugin state changed/ : /identity changed|source changed/,
            );
            const current = openOpenClawStateDatabase({ env }).db;
            expect(rows(current)[0]).toMatchObject({
              entry_key: "first",
              value_json: originals[0].raw,
              created_at: 11,
              expires_at: null,
            });
          } finally {
            interception.mockRestore();
          }
        },
      );
    },
  );
});
