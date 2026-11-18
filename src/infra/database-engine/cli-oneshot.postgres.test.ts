import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  formatCliProcessFailure,
  getCliProcessTestTimeout,
} from "../../cli/cli-process-child.test-helpers.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "../../commands/doctor-config-preflight.process.test-support.js";
import { withSecureTestNodeCommand } from "../../secrets/test-node-command.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { listDirectoryTreeStrict } from "../directory-walk.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const roots = useAutoCleanupTempDirTracker(afterAll);
const childTimeoutMs = 60_000;
// Local PG (2026-10-19, n=3): inspect p95 53.9s, repair p95 74.5s.
// Repair also hit 120s under load; allow cold workers and the complete recovery capture.
const doctorInspectTimeoutMs = 120_000;
const doctorRepairTimeoutMs = 300_000;

describe.skipIf(!connection)("PostgreSQL one-shot CLI", () => {
  it(
    "runs onboarding, agent, model, config and Doctor commands with an exec DSN and no local application tables",
    () =>
      withSecureTestNodeCommand(async (command) => {
        const root = roots.make("postgres-cli-oneshot-");
        const runtimeRoot = createBuiltRuntime(root);
        const stateDir = path.join(root, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const prefix = `cli_parity_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        const credential = "sk-ant-synthetic-cli-oneshot-proof";
        const port = await acquireTestPortBlock({ offsets: [0, 1] });
        const client = new pg.Client({ connectionString: connection });
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_TEST_CLI_DSN: connection,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          CI: "1",
          NO_COLOR: "1",
        };
        await fs.mkdir(stateDir);
        await fs.writeFile(
          configPath,
          JSON.stringify({
            database: {
              engine: "postgres",
              postgres: {
                connection: { source: "exec", provider: "database", id: "connection" },
                schemaPrefix: prefix,
              },
            },
            secrets: {
              providers: {
                database: {
                  source: "exec",
                  command,
                  args: [
                    "-e",
                    "process.stdin.resume(); process.stdout.write(process.env.OPENCLAW_TEST_CLI_DSN)",
                  ],
                  passEnv: ["OPENCLAW_TEST_CLI_DSN"],
                  jsonOnly: false,
                },
              },
            },
            gateway: {
              mode: "local",
              port: port.port,
              auth: { mode: "token", token: "synthetic-cli-oneshot-token" },
            },
            plugins: { enabled: true, allow: ["anthropic"] },
            meta: { migrations: { webhookListeners: true } },
          }),
        );
        const commands = [
          [
            "onboard",
            "--non-interactive",
            "--accept-risk",
            "--auth-choice",
            "apiKey",
            "--token-provider",
            "anthropic",
            "--anthropic-api-key",
            credential,
            "--skip-daemon",
            "--skip-channels",
            "--skip-skills",
            "--skip-search",
            "--skip-health",
            "--skip-ui",
            "--skip-hooks",
            "--workspace",
            path.join(root, "workspace"),
            "--json",
          ],
          [
            "agents",
            "add",
            "probe",
            "--non-interactive",
            "--workspace",
            path.join(root, "probe-workspace"),
            "--json",
          ],
          ["models", "list", "--json"],
          ["models", "status", "--json"],
          ["config", "set", "gateway.port", String(port.port + 1)],
          ["doctor", "--non-interactive", "--no-workspace-suggestions"],
          ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
        ];
        // Credentials and safety journals stay local even when shared and agent stores use PG.
        const credentialRelativePath = path.join("client", "credentials.sqlite");
        const localStores = new Map([
          [
            credentialRelativePath,
            [
              "client_credential_migration",
              "device_auth_tokens",
              "device_identities",
              "gateway_origin_device_tokens",
              "native_exec_socket_credentials",
            ],
          ],
          [
            path.join("state", "openclaw-quarantine.sqlite"),
            ["agent_integrity_verifications", "quarantined_databases"],
          ],
          [
            path.join("control", "services.sqlite"),
            ["daemon_runtime_pin_migration", "daemon_runtime_pins"],
          ],
        ]);
        await client.connect();
        try {
          const schemas = new Set<string>();
          for (const args of commands) {
            const timeoutMs =
              args[0] === "doctor"
                ? args.includes("--fix")
                  ? doctorRepairTimeoutMs
                  : doctorInspectTimeoutMs
                : childTimeoutMs;
            const result = await runBuiltRuntime(runtimeRoot, env, args, timeoutMs);
            expect(
              result.code,
              formatCliProcessFailure({
                reason: `CLI ${args.slice(0, 2).join(" ")} failed`,
                ...result,
              }),
            ).toBe(0);
            expect(`${result.stdout}\n${result.stderr}`).not.toContain(connection);
            const password = new URL(connection!).password;
            if (password) {
              expect(`${result.stdout}\n${result.stderr}`).not.toContain(
                decodeURIComponent(password),
              );
            }
            const databases = (await listDirectoryTreeStrict(stateDir))
              .map((walkEntry) => walkEntry.relativePath)
              .filter((file) => file.endsWith(".sqlite"))
              .map((file) => path.join(stateDir, file));
            expect(databases).toContain(resolveOpenClawStateSqlitePath(env));
            expect(databases).toContain(path.join(stateDir, credentialRelativePath));
            expect(databases.some((file) => path.basename(file) === "openclaw-agent.sqlite")).toBe(
              true,
            );
            for (const database of databases) {
              using anchor = openNodeSqliteDatabase(database, { readOnly: true });
              const relativePath = path.relative(stateDir, database);
              const localTables = localStores.get(relativePath);
              expect(
                anchor
                  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                  .all(),
                `${args[0]} left application tables in ${path.relative(stateDir, database)}`,
              ).toEqual((localTables ?? ["openclaw_engine_anchor"]).map((name) => ({ name })));
              if (localTables) {
                if (relativePath === credentialRelativePath) {
                  expect(anchor.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
                }
                continue;
              }
              const identity = anchor
                .prepare("SELECT engine, schema FROM openclaw_engine_anchor")
                .get();
              expect(identity?.engine).toBe("postgres");
              schemas.add(String(identity?.schema));
            }
          }
          let storedCredentials = 0;
          for (const schema of schemas) {
            const table = await client.query(
              "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'config_machine_state'",
              [schema],
            );
            if (table.rowCount) {
              const persisted = await client.query(
                `SELECT state_key FROM "${schema.replaceAll('"', '""')}".config_machine_state
                WHERE state_key = 'authProfiles.store' AND value_json LIKE $1`,
                [`%${credential}%`],
              );
              storedCredentials += persisted.rowCount ?? 0;
            }
          }
          expect(storedCredentials).toBeGreaterThan(0);
          const authoredConfig = await fs.readFile(configPath, "utf8");
          expect(authoredConfig).not.toContain(connection);
          const config = JSON.parse(authoredConfig);
          expect(config.database.postgres.connection).toEqual({
            source: "exec",
            provider: "database",
            id: "connection",
          });
          expect(config.gateway.port).toBe(port.port + 1);
          expect(config.agents.entries.probe).toBeDefined();
        } finally {
          try {
            const schemas = await client.query<{ schema_name: string }>(
              "SELECT schema_name FROM information_schema.schemata WHERE starts_with(schema_name, $1)",
              [`${prefix}_`],
            );
            for (const { schema_name: schema } of schemas.rows) {
              await client.query(`DROP SCHEMA "${schema}" CASCADE`);
            }
          } finally {
            await client.end();
            await port.release();
          }
        }
      }),
    getCliProcessTestTimeout(
      doctorRepairTimeoutMs,
      doctorInspectTimeoutMs,
      ...Array<number>(5).fill(childTimeoutMs),
    ),
  );
});

describe("CLI with unresolved PostgreSQL credentials", () => {
  it(
    "keeps help, logs and DSN repair available while refusing stateful commands without SQLite fallback",
    () =>
      withSecureTestNodeCommand(async (command) => {
        const root = roots.make("postgres-cli-unresolved-");
        const runtimeRoot = createBuiltRuntime(root);
        const stateDir = path.join(root, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        const logPath = path.join(root, "openclaw.log");
        const port = await acquireTestPortBlock({ offsets: [0] });
        const env: NodeJS.ProcessEnv = {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          CI: "1",
          NO_COLOR: "1",
        };
        try {
          await fs.mkdir(stateDir);
          await fs.writeFile(
            logPath,
            `${JSON.stringify({
              time: "2026-01-09T02:10:00.000Z",
              level: "info",
              message: "synthetic PostgreSQL diagnostic log",
            })}\n`,
          );
          await fs.writeFile(
            configPath,
            JSON.stringify({
              database: {
                engine: "postgres",
                postgres: {
                  connection: {
                    source: "env",
                    provider: "default",
                    id: "OPENCLAW_MISSING_CLI_DSN",
                  },
                },
              },
              gateway: {
                mode: "local",
                port: port.port,
                auth: { mode: "token", token: "synthetic-cli-unresolved-token" },
              },
              logging: { file: logPath, level: "silent", consoleLevel: "silent" },
              plugins: { enabled: false },
            }),
          );
          for (const args of [
            ["--help"],
            ["--version"],
            ["logs", "--limit", "1", "--timeout", "50", "--plain"],
            ["channels", "logs", "--lines", "1", "--json"],
            ["config", "set", "database.postgres.connection.id", "OPENCLAW_REPAIRED_CLI_DSN"],
          ]) {
            const result = await runBuiltRuntime(runtimeRoot, env, args, childTimeoutMs);
            expect(
              result.code,
              formatCliProcessFailure({ reason: `CLI ${args.join(" ")} failed`, ...result }),
            ).toBe(0);
            if (args[0] === "logs" || args[0] === "channels") {
              expect(result.stdout).toContain("synthetic PostgreSQL diagnostic log");
            }
            expect(
              (await listDirectoryTreeStrict(stateDir))
                .map((walkEntry) => walkEntry.relativePath)
                .filter((file) => file.endsWith(".sqlite")),
            ).toEqual([]);
          }
          const repaired = JSON.parse(await fs.readFile(configPath, "utf8"));
          expect(repaired.database.postgres.connection.id).toBe("OPENCLAW_REPAIRED_CLI_DSN");
          const result = await runBuiltRuntime(
            runtimeRoot,
            env,
            ["models", "list", "--json"],
            childTimeoutMs,
          );
          expect(result.code).toBe(1);
          expect(`${result.stdout}\n${result.stderr}`).toContain("SecretRef is unresolved");
          expect(
            (await listDirectoryTreeStrict(stateDir))
              .map((walkEntry) => walkEntry.relativePath)
              .filter((file) => file.endsWith(".sqlite")),
          ).toEqual([]);
          const secret = "postgresql://fixture:synthetic-exec-private-password@localhost/fixture";
          env.OPENCLAW_TEST_CLI_DSN = secret;
          for (const script of ["process.exitCode = 23", ""]) {
            repaired.database.postgres.connection = {
              source: "exec",
              provider: "database",
              id: "connection",
            };
            repaired.secrets = {
              providers: {
                database: {
                  source: "exec",
                  command,
                  args: [
                    "-e",
                    `process.stdin.resume(); process.stderr.write(process.env.OPENCLAW_TEST_CLI_DSN); ${script}`,
                  ],
                  passEnv: ["OPENCLAW_TEST_CLI_DSN"],
                  jsonOnly: false,
                },
              },
            };
            await fs.writeFile(configPath, JSON.stringify(repaired));
            const failed = await runBuiltRuntime(
              runtimeRoot,
              env,
              ["models", "list", "--json"],
              childTimeoutMs,
            );
            const output = `${failed.stdout}\n${failed.stderr}`;
            expect(failed.code).toBe(1);
            expect(output).toContain("database.postgres.connection");
            expect(output).toContain("SecretRef is unresolved (exec:database:connection)");
            expect(output).toContain("Configure a resolvable PostgreSQL DSN");
            expect(output).not.toContain(secret);
            expect(output).not.toContain("synthetic-exec-private-password");
            expect(
              (await listDirectoryTreeStrict(stateDir))
                .map((walkEntry) => walkEntry.relativePath)
                .filter((file) => file.endsWith(".sqlite")),
            ).toEqual([]);
          }
        } finally {
          await port.release();
        }
      }),
    getCliProcessTestTimeout(childTimeoutMs, ...Array<number>(7).fill(childTimeoutMs)),
  );
});
