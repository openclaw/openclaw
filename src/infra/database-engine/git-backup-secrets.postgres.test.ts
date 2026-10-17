import "./backup-worker.test-support.js";
import assert from "node:assert/strict";
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
import { readBackupEngine, verifyMatchedPostgresBackup } from "../../snapshot/database-backup.js";
import {
  dumpGitBackupDatabase,
  restoreGitBackupDirectory,
} from "../../snapshot/git-backup-codec.js";
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
  it.each([
    { family: "state", generic: false },
    { family: "agent", generic: false },
    { family: "state", generic: true },
    { family: "agent", generic: true },
  ] as const)(
    "redacts the same $family rows and fields with generic scope=$generic, including deleted bytes",
    async ({ family, generic }) => {
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
            const pgIdentity = generic
              ? { role: "generic" as const, id: `retained_${family}` }
              : identity;
            const sourcePath = state.path("source.sqlite");
            using source = openNodeSqliteDatabase(sourcePath);
            source.exec(descriptor.sqlite);
            for (const fragment of descriptor.fragments ?? []) {
              source.exec(fragment.sqlite);
            }
            source.exec(`PRAGMA user_version = ${descriptor.version}`);
            source
              .prepare("INSERT INTO schema_meta VALUES ('primary', ?, ?, ?, NULL, 1, 1)")
              .run(identity.role, descriptor.version, family === "state" ? null : "main");
            if (family === "state") {
              source
                .prepare(
                  "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', ?, 1)",
                )
                .run(String(descriptor.version));
              for (const key of [
                "authProfiles.store",
                "nodeHost.config",
                "webPush.vapidKeys",
                "sidebar.retained",
              ]) {
                source
                  .prepare("INSERT INTO config_machine_state VALUES (?, ?, 1)")
                  .run(key, key === "sidebar.retained" ? '"keep"' : JSON.stringify(secret));
              }
              source.exec(`
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
                INSERT INTO web_push_approval_deliveries VALUES (
                  'approval', 'subscription', 'device', NULL, 1
                );
              `);
              source
                .prepare("INSERT INTO device_auth_tokens VALUES ('device', 'operator', ?, '[]', 1)")
                .run(secret);
              source
                .prepare(
                  "INSERT INTO secret_store_entries VALUES ('team', '', 'fixture', ?, 'secret', 1, 1, NULL, NULL, NULL)",
                )
                .run(secret);
            } else {
              source.exec(
                "INSERT INTO session_key_contract (id, main_key, updated_at) VALUES (1, 'main', 0)",
              );
              source
                .prepare("INSERT INTO auth_profile_store VALUES ('main', ?, 1)")
                .run(JSON.stringify(secret));
              source
                .prepare("INSERT INTO auth_profile_state VALUES ('main', ?, 1)")
                .run(JSON.stringify(secret));
              source.exec(
                "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES ('agent:main:main', 'session', '{}', 1)",
              );
              source
                .prepare(
                  "INSERT INTO session_suggestions (id, session_key, author_id, text, created_at, state) VALUES ('suggestion', 'agent:main:main', 'owner', ?, 1, 'pending')",
                )
                .run(secret);
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
                source
                  .prepare("INSERT INTO cache_entries VALUES (?, 'catalog', ?, NULL, NULL, 1)")
                  .run(scope, catalog);
                source
                  .prepare("INSERT INTO cache_entries VALUES (?, 'broken', ?, NULL, NULL, 1)")
                  .run(scope, secret);
              }
              source.exec(
                "INSERT INTO cache_entries VALUES ('unrelated', 'keep', '{\"retained\":true}', NULL, NULL, 1)",
              );
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
                  `SELECT COUNT(*) AS n FROM ${family === "state" ? "device_auth_tokens" : "auth_profile_store"}`,
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
            if (!generic) {
              for (const [index, directory] of [pgDir, unredacted].entries()) {
                const targetPath = state.path(`restored-${index}.sqlite`);
                await restoreGitBackupDirectory({
                  sourcePath: directory,
                  targetPath,
                  expectedIdentity: pgIdentity,
                });
                const restored = readBackupEngine(targetPath);
                assert(restored.engine === "postgres");
                try {
                  expect(restored.storeId).toBe(storeId);
                  expect(restored.namespace).not.toBe(namespace);
                  const retained =
                    family === "state"
                      ? `SELECT value_json FROM "${restored.namespace}".config_machine_state WHERE state_key = 'sidebar.retained'`
                      : `SELECT value_json FROM "${restored.namespace}".cache_entries WHERE scope = 'unrelated' AND key = 'keep'`;
                  expect((await client.query(retained)).rows).toEqual([
                    { value_json: family === "state" ? '"keep"' : '{"retained":true}' },
                  ]);
                  const secretTable =
                    family === "state" ? "device_auth_tokens" : "auth_profile_store";
                  expect(
                    (
                      await client.query(
                        `SELECT count(*)::int AS n FROM "${restored.namespace}"."${secretTable}"`,
                      )
                    ).rows,
                  ).toEqual([{ n: index }]);
                  if (family === "state") {
                    expect(
                      (
                        await client.query(
                          `SELECT count(*)::int AS n FROM "${restored.namespace}".web_push_approval_deliveries`,
                        )
                      ).rows,
                    ).toEqual([{ n: index }]);
                  }
                } finally {
                  await client.query(`DROP SCHEMA "${restored.namespace}" CASCADE`);
                }
              }
            }
          } finally {
            await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
            await client.end();
          }
        },
      );
    },
  );
});
