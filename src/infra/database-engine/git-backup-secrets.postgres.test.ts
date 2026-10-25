import "./backup-worker.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { verifyMatchedPostgresBackup } from "../../snapshot/database-backup.js";
import { dumpGitBackupDatabase } from "../../snapshot/git-backup-codec.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { agentPortProvider } from "./agent-port.js";
import { materializeDatabasePort } from "./port.worker.js";
import { statePortProvider } from "./state-port.js";

const configured = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const secret = "synthetic-secret-must-not-appear-in-export";

afterEach(() => clearRuntimeConfigSnapshot());

describe.skipIf(!connection)("Git backup secret exclusion across engines", () => {
  it.each(["state", "agent"] as const)(
    "redacts $family rows and fields in a generic scope, including deleted bytes",
    async (family) => {
      await withOpenClawTestState(
        { scenario: "minimal", prefix: "git-secrets-" },
        async (state) => {
          const config = { database: { engine: "postgres" as const, postgres: { connection } } };
          await state.writeConfig(config);
          setRuntimeConfigSnapshot(config);
          const client = new Client({ connectionString: connection });
          await client.connect();
          const namespace = `secrets_${randomUUID().replaceAll("-", "")}`;
          try {
            const descriptor = await (
              family === "state" ? statePortProvider : agentPortProvider
            ).loadDescriptor();
            const identity =
              family === "state"
                ? { role: "global" as const }
                : { role: "agent" as const, agentId: "main" };
            const pgIdentity = { role: "generic" as const, id: `retained_${family}` };
            const sourcePath = state.path("source.sqlite");
            using source = openNodeSqliteDatabase(sourcePath);
            source.exec(descriptor.sqlite);
            for (const fragment of descriptor.fragments ?? []) {
              source.exec(fragment.sqlite);
            }
            source.exec(`PRAGMA user_version = ${descriptor.version};
              INSERT INTO schema_meta VALUES ('primary', '${identity.role}', ${descriptor.version},
                ${family === "state" ? "NULL" : "'main'"}, NULL, 1, 1);`);
            if (family === "state") {
              source.exec(`
                INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${descriptor.version}', 1);
                INSERT INTO config_machine_state VALUES ('sidebar.retained', '"keep"', 1);
                INSERT INTO secret_store_entries VALUES ('team', '', 'fixture', '${secret}', 'secret', 1, 1, NULL, NULL, NULL);
                INSERT INTO operator_approvals (
                  cursor_id, approval_id, resolution_ref, kind, status, presentation_json,
                  reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
                  created_at_ms, expires_at_ms, updated_at_ms
                ) VALUES (1, 'approval', '${"a".repeat(43)}', 'exec', 'pending', '{}',
                  '[]', '[]', 'fixture', 1, 2, 1);
                INSERT INTO web_push_subscriptions (
                  endpoint_hash, subscription_id, endpoint, p256dh, auth, created_at_ms, updated_at_ms
                ) VALUES ('endpoint', 'subscription', 'https://push.example.test',
                  'synthetic-key', 'synthetic-auth', 1, 1);
                INSERT INTO web_push_approval_deliveries VALUES ('approval', 'subscription', 'device', NULL, 1);
              `);
              for (const key of ["authProfiles.store", "nodeHost.config", "webPush.vapidKeys"]) {
                source
                  .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
                  .run(key, JSON.stringify(secret));
              }
            } else {
              source.exec(`
                INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0);
                INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
                  VALUES ('agent:main:main', 'session', '{}', 1);
                INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state)
                  VALUES ('suggestion', 'agent:main:main', 'owner', '${secret}', 1, 'pending');
                INSERT INTO cache_entries VALUES ('unrelated', 'keep', '{"retained":true}', NULL, NULL, 1);
              `);
              for (const table of ["auth_profile_store", "auth_profile_state"]) {
                source
                  .prepare(`INSERT INTO ${table} VALUES ('main', ?, 1)`)
                  .run(JSON.stringify(secret));
              }
              const catalog = JSON.stringify({
                generatedBy: "openclaw-plugin-model-catalog-v1",
                providers: {
                  fixture: {
                    apiKey: secret,
                    headers: { Authorization: secret },
                    models: [{ id: "model", apiKey: secret, headers: { "X-Secret": secret } }],
                  },
                },
              });
              for (const scope of [
                "plugin-model-catalog-v1",
                "plugin-model-catalog-migration-v1",
              ]) {
                const insert = source.prepare(
                  "INSERT INTO cache_entries VALUES (?, ?, ?, NULL, NULL, 1)",
                );
                insert.run(scope, "catalog", catalog);
                insert.run(scope, "broken", secret);
              }
            }
            const storeId = randomUUID();
            await materializeDatabasePort({
              source: { engine: "sqlite", db: source },
              destination: { engine: "postgres", db: client, namespace },
              descriptor,
              storeId,
              assertCurrent() {},
            });
            const anchorPath = state.path("anchor.sqlite");
            {
              using anchor = openNodeSqliteDatabase(anchorPath);
              anchor.exec(
                "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL, schema TEXT NOT NULL)",
              );
              anchor
                .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
                .run(storeId, namespace);
            }
            const sqliteDir = state.path("sqlite-git");
            const pgDir = state.path("pg-git");
            const sqliteManifest = await dumpGitBackupDatabase({
              snapshotPath: sourcePath,
              outputPath: sqliteDir,
              identity,
              excludeSecrets: true,
            });
            const pgManifest = await dumpGitBackupDatabase({
              snapshotPath: anchorPath,
              outputPath: pgDir,
              identity: pgIdentity,
              excludeSecrets: true,
            });
            expect(pgManifest.schemaVersion).toBe(2);
            expect(pgManifest.excludedTables).toEqual(sqliteManifest.excludedTables);
            expect(pgManifest.excludedConfigStateKeyPrefixes).toEqual(
              sqliteManifest.excludedConfigStateKeyPrefixes,
            );
            const envelope = await verifyMatchedPostgresBackup(
              path.join(pgDir, "postgres"),
              "user-backup",
            );
            const imagePath = path.join(pgDir, "postgres", "database.sqlite");
            using image = openNodeSqliteDatabase(imagePath);
            if (family === "state") {
              expect(
                image
                  .prepare("SELECT name FROM sqlite_schema WHERE name = 'device_auth_tokens'")
                  .all(),
              ).toEqual([]);
            }
            for (const table of sqliteManifest.excludedTables) {
              expect(image.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n).toBe(0);
              expect(envelope.verification.tables[table]?.rows).toBe(0);
            }
            const retainedTable = family === "state" ? "config_machine_state" : "cache_entries";
            const sqliteRows = (
              await fs.readFile(path.join(sqliteDir, "tables", `${retainedTable}.jsonl`), "utf8")
            )
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line));
            const pgRows = image
              .prepare(
                `SELECT * FROM ${retainedTable} ORDER BY ${family === "state" ? "state_key" : "scope, key"}`,
              )
              .all();
            expect(pgRows).toEqual(sqliteRows);
            expect((await fs.readFile(imagePath)).includes(Buffer.from(secret))).toBe(false);
            expect(
              source
                .prepare(
                  `SELECT COUNT(*) AS n FROM ${family === "state" ? "secret_store_entries" : "auth_profile_store"}`,
                )
                .get()?.n,
            ).toBe(1);
            // The default still captures credentials; exclusion must be an explicit choice.
            const unredacted = state.path("pg-full");
            await dumpGitBackupDatabase({
              snapshotPath: anchorPath,
              outputPath: unredacted,
              identity: pgIdentity,
            });
            expect(
              (await fs.readFile(path.join(unredacted, "postgres", "database.sqlite"))).includes(
                Buffer.from(secret),
              ),
            ).toBe(true);
          } finally {
            await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
            await client.end();
          }
        },
      );
    },
  );
});
