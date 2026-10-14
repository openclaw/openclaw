import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createBackupResourcePlan } from "../../commands/backup-resource-inventory.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveActivatedPluginBackupInventory } from "../../plugins/manifest-backup-resources.js";
import {
  preparePostgresRestore,
  readBackupEngine,
  verifyMatchedPostgresBackup,
} from "../../snapshot/database-backup.js";
import {
  dumpGitBackupDatabase,
  restoreGitBackupDirectory,
} from "../../snapshot/git-backup-codec.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createBackupSqliteSnapshotPlan } from "../backup-sqlite-snapshot.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { createUpdateDatabaseBackup } from "../update-database-backup.js";
import { restoreUpdateDatabaseBackup } from "../update-database-restore.js";
import { materializeDatabasePort, type PortDescriptor } from "./port.worker.js";
import { expectedPostgresCatalog } from "./postgres-catalog.js";
import metadata from "./workboard-port.generated.json" with { type: "json" };

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const canonicalText = ' {"first":1,"first":2,"escaped":"\\u0000"} \n';

async function fixture(
  run: (input: {
    client: Client;
    state: OpenClawTestState;
    anchorPath: string;
    config: OpenClawConfig;
    namespace: string;
    storeId: string;
    namespaces: Set<string>;
  }) => Promise<void>,
) {
  assert(connection);
  await withOpenClawTestState({ scenario: "minimal", prefix: "pg-backup-" }, async (state) => {
    const client = new Client({ connectionString: connection });
    const namespace = `backup_${randomUUID().replaceAll("-", "")}`;
    const namespaces = new Set([namespace]);
    const storeId = randomUUID();
    const anchorPath = state.statePath("plugins", "workboard", "workboard.sqlite");
    const config: OpenClawConfig = {
      database: { engine: "postgres", postgres: { connection } },
      plugins: { entries: { workboard: { enabled: true } } },
    };
    await state.writeConfig(config);
    await fs.mkdir(path.dirname(anchorPath), { recursive: true });
    await client.connect();
    try {
      const postgres = await fs.readFile(
        new URL("../../../extensions/workboard/src/workboard-schema.postgres.sql", import.meta.url),
        "utf8",
      );
      const descriptor: PortDescriptor = {
        ...metadata,
        preData: postgres.slice(metadata.preData[0], metadata.preData[1]),
        postData: postgres.slice(metadata.postData[0], metadata.postData[1]),
        expectedCatalog: expectedPostgresCatalog(metadata),
      };
      {
        using source = openNodeSqliteDatabase(":memory:", { readBigInts: true });
        source.exec(descriptor.sqlite);
        source
          .prepare(
            "INSERT INTO workboard_boards (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run("board", "", -9223372036854775808n, 9223372036854775807n);
        source
          .prepare(
            "INSERT INTO workboard_cards (id, board_id, title, status, priority, position, created_at, updated_at, automation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            "card",
            "board",
            "Retained 🦞",
            "todo",
            "normal",
            0.5,
            9007199254740993n,
            1,
            canonicalText,
          );
        source
          .prepare("INSERT INTO workboard_attachment_blobs VALUES (?, ?)")
          .run("blob", Buffer.from([0, 255, 128, 1]));
        source
          .prepare(
            "INSERT INTO workboard_card_notifications (id, card_id, ordinal, kind, message, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("notification", "card", 1, "status", "line one\nline two", 3, 9007199254740995n);
        await materializeDatabasePort({
          source: { engine: "sqlite", db: source },
          destination: { engine: "postgres", db: client, namespace },
          descriptor,
          storeId,
          assertCurrent() {},
        });
      }
      {
        using anchor = openNodeSqliteDatabase(anchorPath);
        anchor.exec(
          "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)",
        );
        anchor
          .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
          .run(storeId, namespace);
      }
      await run({ client, state, anchorPath, config, namespace, storeId, namespaces });
    } finally {
      await closeOpenClawStateDatabaseAsync();
      for (const owned of namespaces) {
        await client.query(`DROP SCHEMA IF EXISTS "${owned}" CASCADE`);
      }
      await client.end();
    }
  });
}

async function expectRestored(client: Client, namespace: string) {
  expect(
    (
      await client.query(
        `SELECT title, automation_json, created_at FROM "${namespace}".workboard_cards`,
      )
    ).rows,
  ).toEqual([
    { title: "Retained 🦞", automation_json: canonicalText, created_at: "9007199254740993" },
  ]);
  expect(
    (await client.query(`SELECT sequence FROM "${namespace}".workboard_card_notifications`)).rows,
  ).toEqual([{ sequence: "9007199254740995" }]);
  expect(
    (await client.query(`SELECT content FROM "${namespace}".workboard_attachment_blobs`)).rows,
  ).toEqual([{ content: Buffer.from([0, 255, 128, 1]) }]);
}

describe.skipIf(!connection)("matched PostgreSQL backup and update recovery", () => {
  it("restores a user export into a fresh namespace and rejects an unmatched anchor", async () => {
    await fixture(async ({ client, state, anchorPath, config, namespace, storeId, namespaces }) => {
      const originalAnchor = await fs.readFile(anchorPath);
      const inventory = resolveActivatedPluginBackupInventory({
        config,
        env: state.env,
        stateDir: state.stateDir,
      });
      const resources = await createBackupResourcePlan({
        stateDir: state.stateDir,
        configPaths: [],
        oauthDirs: [],
        workspaceDirs: [],
        excludedWorkspaceDirs: [],
        agentRoots: [],
        pluginResources: inventory.resources,
        pluginRoots: inventory.pluginRoots,
      });
      const tempDir = state.path("archive-staging");
      await fs.mkdir(tempDir);
      const plan = await createBackupSqliteSnapshotPlan({
        resources,
        tempDir,
        legacyAuditSnapshots: [],
      });
      const capsule = plan.snapshots.filter((asset) =>
        asset.archiveSourcePath.startsWith(`${anchorPath}.postgres/`),
      );
      expect(capsule).toHaveLength(3);
      const directory = state.path("extracted", "workboard.sqlite.postgres");
      await fs.mkdir(directory, { recursive: true });
      for (const asset of capsule) {
        await fs.copyFile(
          asset.sourcePath,
          path.join(directory, path.basename(asset.archiveSourcePath)),
        );
      }
      const manifest = await verifyMatchedPostgresBackup(directory, "user-backup");
      expect(manifest).toMatchObject({
        profile: "user-backup",
        source: { engine: "postgres", namespace, storeId },
      });
      expect(JSON.stringify(manifest)).not.toContain(connection);
      expect(manifest.sanitizedDifferences).toEqual([]);
      expect(await fs.readFile(anchorPath)).toEqual(originalAnchor);
      await expect(verifyMatchedPostgresBackup(directory, "exact")).rejects.toThrow();
      await expect(verifyMatchedPostgresBackup(directory, "user-backup")).resolves.toEqual(
        manifest,
      );
      const restoredAnchor = state.path("restored.sqlite");
      const restored = await preparePostgresRestore({
        directory,
        anchorPath: restoredAnchor,
        config,
        profile: "user-backup",
        assertCurrent() {},
      });
      namespaces.add(restored.namespace);
      expect(restored.namespace).not.toBe(namespace);
      expect(readBackupEngine(restoredAnchor)).toEqual({
        engine: "postgres",
        namespace: restored.namespace,
        storeId,
      });
      await expectRestored(client, restored.namespace);
      await expectRestored(client, namespace);
      {
        using wrong = openNodeSqliteDatabase(path.join(directory, "anchor.sqlite"));
        wrong.prepare("UPDATE openclaw_engine_anchor SET store_id = ?").run(randomUUID());
      }
      await expect(verifyMatchedPostgresBackup(directory, "user-backup")).rejects.toThrow();
    });
  });

  it("restores a Git backup into a fresh namespace", async () => {
    await fixture(async ({ client, state, anchorPath, namespace, storeId, namespaces }) => {
      const gitPath = state.path("git-backup");
      const identity = { role: "generic", id: "workboard" } as const;
      const gitManifest = await dumpGitBackupDatabase({
        snapshotPath: anchorPath,
        outputPath: gitPath,
        identity,
      });
      expect(gitManifest.schemaVersion).toBe(2);
      const gitTarget = state.path("git-restored.sqlite");
      await restoreGitBackupDirectory({
        sourcePath: gitPath,
        targetPath: gitTarget,
        expectedIdentity: identity,
      });
      const gitAnchor = readBackupEngine(gitTarget);
      assert(gitAnchor.engine === "postgres");
      namespaces.add(gitAnchor.namespace);
      expect(gitAnchor.storeId).toBe(storeId);
      expect(gitAnchor.namespace).not.toBe(namespace);
      await expectRestored(client, gitAnchor.namespace);
    });
  });

  it("captures and rolls back exact updater state while retaining the migrated namespace", async () => {
    await fixture(async ({ client, state, anchorPath, config, namespace, storeId, namespaces }) => {
      openOpenClawStateDatabase({ env: state.env });
      await closeOpenClawStateDatabaseAsync();
      const backup = await createUpdateDatabaseBackup({
        backupRoot: state.path("candidate"),
        stateDir: state.stateDir,
        config,
        env: state.env,
        stopped: true,
      });
      const entry = backup.databases.find((item) => item.path === anchorPath);
      expect(entry).toMatchObject({ engine: "postgres", namespace, storeId });
      assert(entry?.exportDirectory);
      await expect(
        verifyMatchedPostgresBackup(entry.exportDirectory, "exact"),
      ).resolves.toMatchObject({ profile: "exact" });
      await client.query(`UPDATE "${namespace}".workboard_cards SET title = 'Migrated'`);
      const displaced = await restoreUpdateDatabaseBackup({
        backup,
        runId: "pg-exact-recovery",
        env: state.env,
        assertCurrent() {},
      });
      expect(displaced).toContain(`PostgreSQL namespace ${namespace}`);
      const restored = readBackupEngine(anchorPath);
      assert(restored.engine === "postgres");
      namespaces.add(restored.namespace);
      expect(restored.namespace).not.toBe(namespace);
      expect(restored.storeId).toBe(storeId);
      await expectRestored(client, restored.namespace);
      expect((await client.query(`SELECT title FROM "${namespace}".workboard_cards`)).rows).toEqual(
        [{ title: "Migrated" }],
      );
      expect(readBackupEngine(`${anchorPath}.migrated-pg-exact-recovery`)).toEqual({
        engine: "postgres",
        namespace,
        storeId,
      });
    });
  });
});
