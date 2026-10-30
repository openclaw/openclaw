import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { withDoctorSqliteMaintenanceLock } from "../commands/doctor-sqlite-maintenance-lock.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { observePluginStateReads } from "../plugin-state/plugin-state-fixtures.test-support.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
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
import type { EngineConnection } from "./sql-connection.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";
import * as mutationAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import {
  runPluginDoctorStateMigrationPlans,
  runPostSessionPluginDoctorStateRepairs,
} from "./state-migrations.plugin-doctor.js";

function withDoctorState(run: Parameters<typeof withOpenClawTestState>[1]) {
  return withOpenClawTestState({ label: "plugin-doctor", applyEnv: false }, async (state) => {
    try {
      return await run(state);
    } finally {
      vi.restoreAllMocks();
    }
  });
}
function inDoctorState(run: Parameters<typeof withDoctorState>[0]) {
  return () => withDoctorState(run);
}
type Env = NodeJS.ProcessEnv;
type Context = ReturnType<typeof doctorContext>;
type IdentityState = "unknown" | "absent" | "current";
function putSession(
  env: Env,
  sessionKey: string,
  sessionId: string,
  storePath?: string,
  updatedAt = 1,
) {
  return replaceSessionEntry(
    { agentId: "main", env, sessionKey, storePath },
    { sessionId, updatedAt },
  );
}
function expectIdentity(context: Context, ...expected: Parameters<typeof identity>) {
  return expect(
    context.readSessionIdentityEvidenceBatch?.([identity(expected[0])]),
  ).resolves.toEqual([identity(...expected)]);
}
function doctorContext(
  env: NodeJS.ProcessEnv,
  options: Partial<Omit<Parameters<typeof createPluginDoctorStateMigrationContext>[0], "env">> = {},
) {
  return createPluginDoctorStateMigrationContext({
    pluginId: "codex",
    config: {},
    env,
    ...options,
  });
}
function expiringAuthority() {
  let active = true;
  return {
    expire: () => {
      active = false;
    },
    assertCurrent() {
      if (!active) {
        throw new Error("repair owner expired");
      }
    },
  };
}
function ingressContext(
  env: Env,
  stateDir: string,
  channelId: string,
  mutation: ReturnType<typeof expiringAuthority>,
) {
  return doctorContext(env, {
    pluginId: channelId,
    channelIngress: { channelIds: [channelId], stateDir, mutation },
  });
}
function identity(sessionId: string, state?: IdentityState, sessionKey?: string) {
  return { agentId: "main", sessionId, ...(state && { state }), ...(sessionKey && { sessionKey }) };
}
afterEach(clearRuntimeConfigSnapshot);

it(
  "rolls back claims after authority expires",
  inDoctorState(async ({ env, stateDir }) => {
    const authority = expiringAuthority();
    const context = ingressContext(env, stateDir, "line", authority);
    const queue = context.channelIngressQueues?.[0]?.openChannelIngressQueue?.();
    if (!queue) {
      throw new Error("Missing Doctor repair queue");
    }
    await queue.enqueue("pending", { text: "retained" });
    probe.admission(mutationAdmission, (request, grant, admit) => {
      if (request.stage === "commit") {
        authority.expire();
      }
      admit(request, grant);
    });
    const outcome = await queue.claim("pending").then(
      () => undefined,
      (error: unknown) => error,
    );
    const reader = createChannelIngressQueue({ channelId: "line", stateDir });
    expect((await reader.listPending()).map((row) => row.id)).toEqual(["pending"]);
    expect(await reader.listClaims()).toEqual([]);
    expect(outcome).toMatchObject({ message: expect.stringContaining("repair owner expired") });
  }),
);

describe("plugin doctor session identity evidence", () => {
  it(
    "preserves ambiguity for two current keys",
    inDoctorState(async ({ env }) => {
      setRuntimeConfigSnapshot({});
      for (const sessionKey of ["agent:main:main", "agent:main:other"]) {
        await putSession(env, sessionKey, "shared-id");
      }
      await expectIdentity(doctorContext(env), "shared-id", "unknown");
    }),
  );
  it.each([
    { kind: "per-agent", state: "absent" },
    { kind: "fixed", state: "absent" },
    { kind: "missing", state: "unknown" },
    { kind: "broken", state: "unknown" },
  ] as const)("reports $state for a $kind store", async ({ kind, state }) => {
    await withDoctorState(async ({ env, root }) => {
      const fixedStorePath = path.join(root, "fixed.sqlite");
      const config: OpenClawConfig = kind === "fixed" ? { session: { store: fixedStorePath } } : {};
      if (kind !== "missing") {
        const database = openOpenClawAgentDatabase({
          agentId: "main",
          env,
          ...(kind === "fixed" ? { path: fixedStorePath } : {}),
        });
        if (kind === "broken") {
          database.db.exec("PRAGMA user_version = 999");
          await closeOpenClawAgentDatabaseByPathAsync(database.path);
        }
      }
      const context = doctorContext(env, { config });
      await expectIdentity(context, "gone", state);
      if (state === "absent") {
        expect(context.deletePluginStateEntriesIfUnchanged).toBeUndefined();
      }
    });
  });
  it.each([
    ["entry_json", "{broken", "broken-session"],
    ["current_session_id", "wrong-session", "wrong-session"],
  ])("keeps corrupt %s fixed-store rows unknown", async (column, value, sessionId) => {
    await withDoctorState(async ({ env, root }) => {
      const storePath = path.join(root, "fixed.sqlite");
      const sessionKey = "agent:main:broken";
      await putSession(env, sessionKey, "broken-session", storePath);
      const database = openOpenClawAgentDatabase({ agentId: "main", env, path: storePath }).db;
      database
        .prepare(`UPDATE session_nodes SET ${column} = ? WHERE session_key = ?`)
        .run(value, sessionKey);
      const context = doctorContext(env, { config: { session: { store: storePath } } });
      await expectIdentity(context, sessionId, "unknown");
    });
  });
  it(
    "refreshes canonical identity in Doctor",
    inDoctorState(async ({ env, root }) => {
      const storePath = path.join(root, "fixed.sqlite");
      const sessionKey = "agent:main:renamed";
      await putSession(env, sessionKey, "live", storePath);
      const context = doctorContext(env, { config: { session: { store: storePath } } });
      const requests = [identity("live"), identity("gone"), identity("live")];
      await expect(context.readSessionIdentityEvidenceBatch?.([])).resolves.toEqual([]);
      await expect(context.readSessionIdentityEvidenceBatch?.(requests)).resolves.toEqual([
        identity("live", "current", sessionKey),
        identity("gone", "absent"),
        identity("live", "current", sessionKey),
      ]);
      // Discovery may be cached within a context; row evidence must be read anew.
      await putSession(env, sessionKey, "gone", storePath, 2);
      await expect(context.readSessionIdentityEvidenceBatch?.(requests)).resolves.toEqual([
        identity("live", "absent"),
        identity("gone", "current", sessionKey),
        identity("live", "absent"),
      ]);
    }),
  );
  it(
    "deduplicates SQLite and JSON aliases",
    inDoctorState(async ({ env, stateDir }) => {
      const agentRoot = path.join(stateDir, "agents", "main");
      const storePath = path.join(agentRoot, "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.join(agentRoot, "sessions"), { recursive: true });
      const sessionKey = "agent:main:renamed";
      await putSession(env, sessionKey, "live", storePath);
      const context = doctorContext(env, {
        config: {
          session: {
            store: path.join(stateDir, "agents", "{agentId}", "agent", "openclaw-agent.sqlite"),
          },
        },
      });
      await expectIdentity(context, "live", "current", sessionKey);
    }),
  );
  it(
    "revokes retained repair callbacks",
    inDoctorState(async ({ env }) => {
      const authority = expiringAuthority();
      const context = doctorContext(env, {
        repairAuthority: {
          assertCurrent: () => authority.assertCurrent(),
          assertOwnedInTransaction() {},
        },
      });
      const options = { namespace: "doctor-repair", maxEntries: 10 };
      const range = { prefix: "binding:", limit: 10 };
      const store = context.openPluginStateKeyedStore<{ sessionId: string }>(options);
      await store.register("binding:retained", { sessionId: "gone" });
      const observed = context.readPluginStateEntriesInKeyRange?.(options.namespace, range);
      expect(observed).toHaveLength(1);
      authority.expire();
      expect(() =>
        context.deletePluginStateEntriesIfUnchanged?.(options.namespace, observed ?? []),
      ).toThrow("repair owner expired");
      expect(() => context.readPluginStateEntriesInKeyRange?.(options.namespace, range)).toThrow(
        "repair owner expired",
      );
      await expect(context.readSessionIdentityEvidenceBatch?.([identity("gone")])).rejects.toThrow(
        "repair owner expired",
      );
      await expect(store.lookup("binding:retained")).resolves.toEqual({ sessionId: "gone" });
    }),
  );
  it(
    "revokes retained ingress purge",
    inDoctorState(async ({ env, stateDir }) => {
      const authority = expiringAuthority();
      const context = ingressContext(env, stateDir, "migration-fixture", authority);
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
      authority.expire();
      await expect(Promise.resolve().then(() => purge())).rejects.toThrow("repair owner expired");
      expect((await inspection.listPending()).map((entry) => entry.id)).toEqual(["retained"]);
    }),
  );
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
  const firstOriginal = {
    key: "first",
    raw: '{ "version": 1, "lastUpdateId": 777, "extra": ["kept"] }',
    createdAt: 11,
    expiresAt: null,
  };
  const originals = [
    firstOriginal,
    {
      key: "second",
      raw: '{ "version": 2, "lastUpdateId": 999, "botId": "111111" }',
      createdAt: 12,
      expiresAt: 8_000_000_000_000,
    },
  ];
  function insert(db: EngineConnection) {
    return db.prepare(
      "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
  }
  function seed(db: EngineConnection) {
    const statement = insert(db);
    for (const row of originals) {
      statement.run("telegram", namespace, row.key, row.raw, row.createdAt, row.expiresAt);
    }
  }
  function rows(db: EngineConnection) {
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
  function migrationInput(env: Env, stateDir: string, context: Context) {
    return { config: {}, env, stateDir, oauthDir: path.join(stateDir, "credentials"), context };
  }
  function runRepair(env: NodeJS.ProcessEnv) {
    return withDoctorSqliteMaintenanceLock({
      env,
      operation: "telegram-offset-test",
      run: (maintenanceAuthority) =>
        runPostSessionPluginDoctorStateRepairs({ env, config, maintenanceAuthority }),
    });
  }
  type Snapshot = Awaited<ReturnType<typeof sqliteSnapshot.createVerifiedSqliteSnapshot>>;
  function afterSnapshot(run: (backup: Snapshot) => void | Promise<void>) {
    const createSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
    return vi
      .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
      .mockImplementation(async (options) => {
        const backup = await createSnapshot(options);
        await run(backup);
        return backup;
      });
  }
  it(
    "publishes repaired rows to an already warm keyed store",
    inDoctorState(async ({ env }) => {
      seed(openOpenClawStateDatabase({ env }).db);
      const context = doctorContext(env, {
        pluginId: "telegram",
        repairAuthority: {
          assertCurrent() {},
          assertOwnedInTransaction(database) {
            expect(database.isTransaction).toBe(true);
          },
        },
      });
      const store = context.openPluginStateKeyedStore({ namespace, maxEntries: 10 });
      expect(await store.entries()).toHaveLength(2);
      expect(await store.lookup("first")).toEqual(JSON.parse(firstOriginal.raw));
      const observed = context.readPluginStateEntriesInKeyRange!(namespace, {
        prefix: "",
        limit: 10,
      });
      await context.repairPluginStateEntries!(
        namespace,
        observed.map((entry, index) => ({ entry, value: { repaired: index + 1 } })),
      );

      const dispatch = observePluginStateReads();
      expect(await store.entries()).toEqual(
        originals.map((entry, index) => ({
          key: entry.key,
          value: { repaired: index + 1 },
          createdAt: entry.createdAt,
          ...(entry.expiresAt === null ? {} : { expiresAt: entry.expiresAt }),
        })),
      );
      expect(await store.lookup("first")).toEqual({ repaired: 1 });
      expect(dispatch).not.toHaveBeenCalled();
    }),
  );
  it(
    "normalizes once with backup, without credentials",
    inDoctorState(async ({ env, stateDir }) => {
      const { db } = openOpenClawStateDatabase({ env });
      seed(db);
      const before = rows(db);
      const context = doctorContext(env, {
        pluginId: "telegram",
        repairAuthority: {
          assertCurrent() {},
          assertOwnedInTransaction(database) {
            expect(database.isTransaction).toBe(true);
          },
        },
      });
      const migration = await registeredMigration();
      const input = migrationInput(env, stateDir, context);
      expect(await migration.detectLegacyState(input)).not.toBeNull();
      await recordDeferredPluginMigrations({ env, pending });
      const earlier = await runPluginDoctorStateMigrationPlans({
        config,
        env,
        detected: { stateDir, oauthDir: input.oauthDir, doctorOnlyStateMigrations: true },
      });
      expect(earlier.completedPluginIds ?? []).not.toContain("telegram");
      expect(readDeferredPluginMigrations({ env })).toEqual(pending);
      const result = await runRepair(env);
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
      const normalized = [
        { version: 3, lastUpdateId: 777, extra: ["kept"], botId: null, tokenFingerprint: null },
        { version: 3, lastUpdateId: 999, botId: "111111", tokenFingerprint: null },
      ];
      expect(rows(db)).toEqual(
        originals.map((row, index) => ({
          entry_key: row.key,
          value_json: JSON.stringify(normalized[index]),
          created_at: row.createdAt,
          expires_at: row.expiresAt,
        })),
      );
      expect(await migration.detectLegacyState(input)).toBeNull();
      expect(await migration.migrateLegacyState(input)).toEqual({ changes: [], warnings: [] });
    }),
  );
  it.each([
    { raw: '{"version":1,"lastUpdateId":"777"}', padding: 511 },
    { raw: '{"version":1,"lastUpdateId":-1}', padding: 0 },
    { raw: '{"version":2,"lastUpdateId":777,"botId":{}}', padding: 0 },
  ])("leaves malformed durable offsets pending: $raw", async ({ raw, padding }) => {
    await withDoctorState(async ({ env }) => {
      const { db } = openOpenClawStateDatabase({ env });
      seed(db);
      db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = 'second'").run(
        raw,
      );
      db.exec("BEGIN");
      const statement = insert(db);
      for (let index = 0; index < padding; index++) {
        statement.run("telegram", namespace, `middle-${index}`, firstOriginal.raw, 11, null);
      }
      db.exec("COMMIT");
      const before = rows(db);
      await recordDeferredPluginMigrations({ env, pending });
      const result = await runRepair(env);
      expect(result.warnings.join("\n")).toContain(
        'account "second" is malformed; restore its known-good state backup',
      );
      expect(result.changes).toEqual([]);
      expect(rows(db)).toEqual(before);
      expect(readDeferredPluginMigrations({ env })).toEqual(pending);
    });
  });
  it(
    "refuses unsupported inspection",
    inDoctorState(async ({ env, stateDir }) => {
      const context = doctorContext(env, { config, pluginId: "telegram" });
      delete context.readPluginStateEntriesInKeyRange;
      const migration = await registeredMigration();
      const input = { ...migrationInput(env, stateDir, context), config };
      expect(() => migration.detectLegacyState(input)).toThrow(
        "Update OpenClaw before inspecting Telegram SQLite offsets",
      );
      await expect(migration.migrateLegacyState(input)).rejects.toThrow(
        "Update OpenClaw before inspecting Telegram SQLite offsets",
      );
    }),
  );
  it(
    "keeps expired repairs pending",
    inDoctorState(async ({ env }) => {
      const { db } = openOpenClawStateDatabase({ env });
      seed(db);
      await recordDeferredPluginMigrations({ env, pending });
      const expiry = expiringAuthority();
      afterSnapshot(expiry.expire);
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
                expiry.assertCurrent();
              },
            },
          }),
      });
      expect(result.warnings.join("\n")).toContain("repair owner expired");
      expect(readDeferredPluginMigrations({ env })).toEqual(pending);
      expect(rows(db)[0]).toMatchObject({ value_json: firstOriginal.raw });
    }),
  );
  it.each(["row", "generation"] as const)(
    "refuses a changed %s after backup without partially normalizing",
    async (change) => {
      await withDoctorState(async ({ env, stateDir }) => {
        const database = openOpenClawStateDatabase({ env });
        seed(database.db);
        const assertCurrent = () => {};
        const context = doctorContext(env, {
          pluginId: "telegram",
          repairAuthority: { assertCurrent, assertOwnedInTransaction: assertCurrent },
        });
        const migration = await registeredMigration();
        afterSnapshot(async (backup) => {
          if (change === "row") {
            database.db
              .prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = 'second'")
              .run('{"version":3,"lastUpdateId":123,"botId":null,"tokenFingerprint":null}');
          }
          if (change === "generation") {
            await closeOpenClawStateDatabaseAsync();
            fs.renameSync(database.path, `${database.path}.original`);
            fs.copyFileSync(backup.path, database.path);
          }
        });
        await expect(
          migration.migrateLegacyState(migrationInput(env, stateDir, context)),
        ).rejects.toThrow(
          change === "row" ? /Plugin state changed/ : /identity changed|source changed/,
        );
        const current = openOpenClawStateDatabase({ env }).db;
        expect(rows(current)[0]).toMatchObject({
          entry_key: "first",
          value_json: firstOriginal.raw,
          created_at: 11,
          expires_at: null,
        });
      });
    },
  );
});
