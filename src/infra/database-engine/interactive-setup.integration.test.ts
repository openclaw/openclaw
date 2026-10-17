import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createBuiltRuntime,
  ISOLATED_RUNTIME_NODE_ARGS,
} from "../../commands/doctor-config-preflight.process.test-support.js";
import { localOnboardingStateKey } from "../../state/local-onboarding-state-shared.js";
import { resolveTestNodeExecPath } from "../../test-utils/node-process.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { startRuntimePty, type PtyRun } from "../../tui/tui-pty-test-support.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const roots = useAutoCleanupTempDirTracker(afterAll);
const nodeExecutable = resolveTestNodeExecPath();
const commandTimeoutMs = 60_000;
const localJournals = new Map([
  [
    path.join("state", "openclaw-quarantine.sqlite"),
    ["agent_integrity_verifications", "quarantined_databases"],
  ],
  [
    path.join("control", "services.sqlite"),
    ["daemon_runtime_pin_migration", "daemon_runtime_pins"],
  ],
]);

async function answer(run: PtyRun, prompt: string, input = "\r") {
  await run.waitForOutput(prompt);
  await run.write(input);
}

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !connection)(`${engine} interactive setup`, () => {
    const scenarios = [
      { entry: "onboard", recoverConfig: false },
      { entry: "setup", recoverConfig: false },
      { entry: "crestodian", recoverConfig: false },
      ...(engine === "postgres"
        ? ([
            { entry: "onboard", recoverConfig: true },
            { entry: "bare-root", recoverConfig: true },
          ] as const)
        : []),
    ] as const;
    for (const { entry, recoverConfig } of scenarios) {
      const label =
        entry === "bare-root"
          ? "bare root preserves malformed-config Doctor guidance without opening storage"
          : `${entry}${recoverConfig ? " recovers malformed config, then" : ""} saves interactive setup and releases ownership for a Gateway`;
      it(
        label,
        async () => {
          const root = roots.make(`interactive-${entry}-${engine}-`);
          const runtimeRoot = createBuiltRuntime(root);
          const stateDir = path.join(root, ".openclaw");
          const configPath = path.join(stateDir, "openclaw.json");
          const workspace = path.join(stateDir, "workspace");
          const prefix = `interactive_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
          const port = await acquireTestPortBlock({ offsets: [0] });
          // PTY helpers inherit their parent's environment. Explicitly clear it so
          // discovery cannot borrow a real account, provider key, or operator state.
          const env: NodeJS.ProcessEnv = {
            ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])),
            PATH: path.dirname(nodeExecutable),
            SystemRoot: process.env.SystemRoot,
            HOME: root,
            USERPROFILE: root,
            TMPDIR: root,
            TMP: root,
            TEMP: root,
            OPENCLAW_HOME: root,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_TEST_INTERACTIVE_DSN: connection,
            OPENCLAW_GATEWAY_PORT: String(port.port),
            OPENCLAW_NO_RESPAWN: "1",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_SERVICE_REPAIR_POLICY: "external",
            NO_COLOR: "1",
          };
          await fs.mkdir(stateDir);
          const initialConfig = JSON.stringify({
            ...(engine === "postgres"
              ? {
                  database: {
                    engine,
                    postgres: {
                      connection: {
                        source: "env",
                        provider: "default",
                        id: "OPENCLAW_TEST_INTERACTIVE_DSN",
                      },
                      schemaPrefix: prefix,
                    },
                  },
                }
              : {}),
            logging: { file: path.join(root, "gateway.log") },
            plugins: { enabled: false },
          });
          await fs.writeFile(
            configPath,
            `${recoverConfig ? "synthetic warning\n" : ""}${initialConfig}`,
          );
          const client =
            engine === "postgres" ? new pg.Client({ connectionString: connection }) : undefined;
          await client?.connect();
          const runs: PtyRun[] = [];
          const start = async (args: string[]) =>
            await startRuntimePty(
              nodeExecutable,
              [...ISOLATED_RUNTIME_NODE_ARGS, path.join(runtimeRoot, "dist", "entry.js"), ...args],
              {
                activeRuns: runs,
                cwd: runtimeRoot,
                env,
                exitTimeoutMs: commandTimeoutMs,
                outputTimeoutMs: commandTimeoutMs,
              },
            );
          try {
            const args =
              entry === "bare-root"
                ? []
                : entry === "crestodian"
                  ? [entry]
                  : [
                      entry,
                      ...(entry === "setup" ? ["--wizard"] : []),
                      "--skip-ui",
                      "--agent-name",
                      "main",
                      "--workspace",
                      workspace,
                    ];
            const setup = await start(args);
            if (entry === "bare-root") {
              await answer(setup, "Continue?");
              await setup.waitForOutput("Config invalid. Run");
              expect((await setup.waitForExit()).exitCode, setup.output()).toBe(1);
              expect(await fs.readFile(configPath, "utf8")).toBe(
                `synthetic warning\n${initialConfig}`,
              );
              expect(
                (await fs.readdir(stateDir, { recursive: true })).filter((file) =>
                  file.endsWith(".sqlite"),
                ),
              ).toEqual([]);
              return;
            }
            if (recoverConfig) {
              await setup.waitForOutput('Run "openclaw doctor --fix" now?');
              expect(
                (await fs.readdir(stateDir, { recursive: true })).filter((file) =>
                  file.endsWith(".sqlite"),
                ),
              ).toEqual([]);
              expect(await fs.readFile(configPath, "utf8")).toBe(
                `synthetic warning\n${initialConfig}`,
              );
              await setup.write("\r");
              await setup.waitForOutput("Removed non-JSON prefix");
            }
            await answer(setup, "Continue?");
            await answer(setup, "No thanks");
            if (entry === "crestodian") {
              await answer(setup, "What would you like to create?");
              await answer(setup, "What should we call your first agent?");
            } else {
              await answer(setup, "How should I set things up?", "\x1b[B\r");
              await answer(setup, "May I look around to find your AI access?", "\x1b[B\r");
            }
            // The provider picker always offers Skip last. No inference call is
            // needed to prove setup persistence or process ownership handoff.
            await answer(setup, "Model/auth provider", "\x1b[A\r");
            await setup.waitForOutput("Add AI later:");
            expect((await setup.waitForExit()).exitCode, setup.output()).toBe(0);

            const config = JSON.parse(await fs.readFile(configPath, "utf8"));
            expect(config.wizard.securityAcknowledgedAt).toEqual(expect.any(String));
            expect(config.telemetry).toMatchObject({
              enabled: false,
              consentedAt: expect.any(String),
            });
            if (entry !== "crestodian") {
              expect(config.wizard.accessMode).toBe("guarded");
              expect(config.agents.entries.main).toBeDefined();
              expect(
                config.agents.entries.main.workspace ?? config.agents.defaults?.workspace,
              ).toBe(workspace);
              expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).not.toBe("");
            }

            const databases = (await fs.readdir(stateDir, { recursive: true }))
              .filter((file) => file.endsWith(".sqlite"))
              .map((file) => path.join(stateDir, file));
            expect(databases.length).toBeGreaterThan(0);
            let onboardingState: unknown;
            let stateSchema: string | undefined;
            for (const database of databases) {
              using local = openNodeSqliteDatabase(database, { readOnly: true });
              if (engine === "postgres") {
                const journal = localJournals.get(path.relative(stateDir, database));
                expect(
                  local
                    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                    .all(),
                  `${entry} left application state in ${path.relative(stateDir, database)}`,
                ).toEqual((journal ?? ["openclaw_engine_anchor"]).map((name) => ({ name })));
                if (!journal) {
                  const anchor = local
                    .prepare("SELECT engine, schema FROM openclaw_engine_anchor")
                    .get();
                  expect(anchor?.engine).toBe(engine);
                  if (path.relative(stateDir, database) === path.join("state", "openclaw.sqlite")) {
                    stateSchema = String(anchor?.schema);
                  }
                }
              } else if (
                path.relative(stateDir, database) === path.join("state", "openclaw.sqlite")
              ) {
                onboardingState = local
                  .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
                  .get(localOnboardingStateKey(configPath))?.value_json;
              }
            }
            if (client) {
              expect(stateSchema).toBeDefined();
              const stored = await client.query<{ value_json: string }>(
                `SELECT value_json FROM "${stateSchema!.replaceAll('"', '""')}".config_machine_state WHERE state_key = $1`,
                [localOnboardingStateKey(configPath)],
              );
              onboardingState = stored.rows[0]?.value_json;
            }
            if (entry !== "crestodian") {
              expect(JSON.parse(String(onboardingState))).toMatchObject({
                status: "completed",
                configPath,
                workspace,
              });
            }

            await fs.writeFile(
              configPath,
              JSON.stringify({
                ...config,
                gateway: {
                  ...config.gateway,
                  mode: "local",
                  bind: "loopback",
                  port: port.port,
                  auth: { mode: "token", token: "synthetic-interactive-gateway-token" },
                },
              }),
            );
            const gateway = await startRuntimePty(
              nodeExecutable,
              [
                ...ISOLATED_RUNTIME_NODE_ARGS,
                "--import",
                path.join(runtimeRoot, "scripts", "tsx.mjs"),
                fileURLToPath(
                  new URL(
                    "../../commands/onboard-gateway-process.test-support.ts",
                    import.meta.url,
                  ),
                ),
                path.join(runtimeRoot, "dist", "entry.js"),
                String(port.port),
              ],
              {
                activeRuns: runs,
                cwd: runtimeRoot,
                env,
                exitTimeoutMs: commandTimeoutMs,
                outputTimeoutMs: commandTimeoutMs,
              },
            );
            await gateway.waitForOutput("Onboarding child authenticated and ready");
            await gateway.write("\x03");
            expect((await gateway.waitForExit()).exitCode, gateway.output()).toBe(130);
            expect(gateway.output()).toContain(
              "Onboarding parent retained its CLI role after child shutdown",
            );
            expect(gateway.output()).toContain("completed cleanly in");
          } finally {
            for (const run of runs) {
              await run.forceKill();
            }
            if (client) {
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
              }
            }
            await port.release();
          }
        },
        180_000,
      );
    }
  });
}
