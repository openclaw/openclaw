import { once } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForDead, waitForFile } from "../../test/helpers/process-wait.js";
import { withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { updateExecutorEntrypoints } from "../cli/cli-entrypoint.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { getPostgresPhysicalFacts } from "./database-engine/physical-facts.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { writeRestartSentinel } from "./restart-sentinel.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { readManagedHandoffArtifacts } from "./update-managed-service-handoff-artifacts.test-support.js";
// Register the real-process fixture before importing its consumers.
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { resolveManagedHandoffStateEngine } from "./update-managed-service-handoff-sentinel.js";
import { readRestartSentinelPayload } from "./update-managed-service-handoff-state.test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection =
  typeof configured === "string" ? configured : process.env.OPENCLAW_HANDOFF_TEST_CONNECTION;
const { runManagedServiceManagerBoundary, resolvePreferredOpenClawTmpDirMock, spawnMock } =
  useManagedServiceHandoffLifecycleFixture();
const sentinelRuntimeUrl = resolveRuntimeWorkerUrl({
  currentModuleUrl: import.meta.url,
  sourceWorkerName: "update-managed-service-handoff-sentinel",
  distWorkerPath: "infra/update-managed-service-handoff-sentinel.js",
});
const postgresClientPath = createRequire(import.meta.url).resolve("pg");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => afterEach(cleanup));

afterEach(() => {
  resetDatabaseEngineSelectionForTest();
});

const itUnix = it.runIf(process.platform !== "win32");

it.each(["sqlite", "postgres"] as const)(
  "uses the admitted %s selection without inspecting the state file",
  async (engine) => {
    const root = tempDirs.make("handoff-engine-selection-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const pathname = resolveOpenClawStateSqlitePath(env);
    await fs.mkdir(path.dirname(pathname), { recursive: true });
    await fs.writeFile(pathname, "must not be opened as SQLite");
    installDatabaseEngineSelection({
      effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine } }),
    });
    await expect(resolveManagedHandoffStateEngine(env)).resolves.toBe(engine);
  },
);

it("recognizes an offline PostgreSQL anchor through its inspection worker", async () => {
  const root = tempDirs.make("handoff-engine-anchor-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  const pathname = resolveOpenClawStateSqlitePath(env);
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  const db = new DatabaseSync(pathname);
  db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)").run(
    "handoff-fixture",
    "postgres",
    "handoff_fixture",
  );
  db.close();
  await expect(resolveManagedHandoffStateEngine(env)).resolves.toBe("postgres");
});

itUnix.for(["transfer", "cancel"] as const)(
  "settles PostgreSQL %s without retaining parent or helper IPC",
  async (mode, { signal }) => {
    const root = await fs.realpath(tempDirs.make("handoff-parent-exit-"));
    const release = path.join(root, "release-updater");
    const transferred = path.join(root, "transferred.json");
    const updater = path.join(root, "updater.mjs");
    await fs.writeFile(
      updater,
      `
    import fs from "node:fs";
    while (!fs.existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
    process.stdout.write(JSON.stringify({ status: "skipped", mode: "npm", reason: "already-current" }));
  `,
    );
    await fs.mkdir(path.join(root, "state"));
    const db = new DatabaseSync(path.join(root, "state", "openclaw.sqlite"));
    db.exec("CREATE TABLE openclaw_engine_anchor (store_id TEXT, engine TEXT, schema TEXT)");
    db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, ?, ?)").run(
      "exit-fixture",
      "postgres",
      "exit_fixture",
    );
    db.close();
    const parentScript = path.join(root, "parent.mjs");
    await fs.writeFile(
      parentScript,
      `
    import fs from "node:fs";
    import assert from "node:assert/strict";
    const mode = ${JSON.stringify(mode)};
    if (mode === "cancel") {
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
    }
    const { registerSealedRuntime } = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.sealedRegistry).href)});
    registerSealedRuntime({ json5: undefined, resolveSecureTempRoot: () => ${JSON.stringify(root)} });
    const handoff = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorEntrypoints.handoff).href)});
    const result = await handoff.startManagedServiceUpdateHandoff({
      root: ${JSON.stringify(root)}, execPath: process.execPath, argv1: ${JSON.stringify(updater)},
      env: process.env, restartDrainTimeoutMs: 300000, meta: {},
    });
    assert.equal(result.status, "started");
    const identity = { kind: "managed-update-handoff", ...result };
    if (mode === "cancel") assert.equal(await handoff.cancelManagedServiceUpdateHandoff(identity), "restored-in-process");
    else assert(await handoff.transferManagedServiceUpdateHandoff(identity));
    fs.writeFileSync(${JSON.stringify(transferred)}, JSON.stringify(result));
  `,
    );
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const parent = spawn(resolveTestNodeExecPath(), [parentScript], {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      },
      stdio: [mode === "cancel" ? "pipe" : "ignore", "ignore", "pipe"],
    });
    let stderr = "";
    if (!parent.stderr) {
      throw new Error("Parent stderr pipe is unavailable");
    }
    parent.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const closed = once(parent, "close");
    let helperPid: number | undefined;
    try {
      await waitForFile(transferred, signal);
      helperPid = JSON.parse(await fs.readFile(transferred, "utf8")).pid;
      if (mode === "cancel") {
        expect(parent.exitCode, stderr).toBeNull();
        await waitForDead(helperPid!, signal);
      } else {
        expect(await withinTest(closed, signal), stderr).toEqual([0, null]);
      }
    } finally {
      // Release the real updater even when a referenced IPC channel prevents parent exit.
      await fs.writeFile(release, "finish");
      parent.stdin?.end();
      await closed;
      if (helperPid) {
        await waitForDead(helperPid, AbortSignal.timeout(30_000));
      }
    }
  },
);

itUnix("restores a SQLite runtime that has no engine-aware sentinel method", async () => {
  // The installed recovery fixture intentionally has no new operation export.
  const result = await runManagedServiceManagerBoundary("systemd", {
    ledger: true,
    controlDisconnect: "transferred",
    helperExitCode: 7,
    updaterNotification: "published",
    updaterResult: {
      status: "error",
      mode: "npm",
      reason: "candidate-failed",
      recovery: { serviceRestartSafe: true, version: "1.0.0" },
    },
    async prepareState({ env, recoveryModulePath, sourceRuntimeImport }) {
      env.OPENCLAW_LOG_LEVEL = "debug";
      env.OPENCLAW_TEST_CONSOLE = "1";
      await fs.appendFile(
        recoveryModulePath,
        `
        ${sourceRuntimeImport}
        const { resolveSqliteInspectionBudget } = await import(${JSON.stringify(new URL("./sqlite-readonly-worker.ts", import.meta.url).href)});
        resolveSqliteInspectionBudget("handoff fixture", "synthetic.sqlite", 1024);
        `,
      );
    },
  });
  expect(result.stdout.split("\n")[0]).toBe("OPENCLAW_UPDATE_HANDOFF_READY");
  expect(result.stderr).toContain("SQLite handoff fixture for synthetic.sqlite");
  expect(result.state).toMatchObject({ restored: true });
  expect(result.sentinel).toMatchObject({ payload: { status: "error" } });
  expect(result.log).not.toContain("could not be recorded");
});

describe.skipIf(!connection || process.platform === "win32")(
  "generated handoff on PostgreSQL",
  () => {
    it.each(["failure", "completed", "consumed", "foreign", "unavailable"] as const)(
      "%s preserves the anchor and settles the local lease",
      async (outcome) => {
        const client = new Client({ connectionString: connection });
        await client.connect();
        let namespace: string | undefined;
        let anchorPath = "";
        let fixtureEnv: NodeJS.ProcessEnv | undefined;
        const publishedAt = 1_800_000_000_000;
        try {
          const result = await runManagedServiceManagerBoundary("systemd", {
            controlDisconnect: "transferred",
            helperExitCode: outcome === "completed" ? 0 : 7,
            updaterResult: {
              status: "error",
              mode: "npm",
              reason: "candidate-failed",
              recovery: { serviceRestartSafe: true, version: "1.0.0" },
            },
            ...(outcome === "completed"
              ? { updaterExitCode: 0, updaterResult: { status: "ok", mode: "npm" } }
              : {}),
            async prepareState({ env, recoveryModulePath, sourceRuntimeImport }) {
              fixtureEnv = env;
              const root = env.OPENCLAW_STATE_DIR!;
              // The installed child resolves exactly the same canonical local lease store.
              env.TMPDIR = root;
              const leaseDirectory = path.join(root, `openclaw-${process.getuid?.()}`);
              await fs.mkdir(leaseDirectory, { mode: 0o700 });
              resolvePreferredOpenClawTmpDirMock.mockReturnValue(leaseDirectory);
              env.OPENCLAW_HANDOFF_TEST_CONNECTION = connection;
              await fs.writeFile(
                env.OPENCLAW_CONFIG_PATH!,
                JSON.stringify({
                  database: {
                    engine: "postgres",
                    postgres: {
                      connection: {
                        source: "env",
                        provider: "default",
                        id: "OPENCLAW_HANDOFF_TEST_CONNECTION",
                      },
                      schemaPrefix: "handoff_engine",
                    },
                  },
                }),
              );
              installDatabaseEngineSelection({
                effectiveEngines: resolveDatabaseFamilyEngines({
                  database: { engine: "postgres" },
                }),
                postgres: { connection: connection!, schemaPrefix: "handoff_engine" },
              });
              anchorPath = resolveOpenClawStateSqlitePath(env);
              namespace = withEngineStoreAdmission(() => {
                const db = openOpenClawStateDatabase({ env }).db;
                return getPostgresPhysicalFacts(db)!.namespace;
              });
              if (["failure", "completed", "consumed", "foreign"].includes(outcome)) {
                await writeRestartSentinel(
                  {
                    kind: "update",
                    status: outcome === "completed" ? "ok" : "error",
                    ts: publishedAt,
                    message: "Published candidate result survives handoff.",
                    stats: {
                      handoffId: outcome === "foreign" ? "another-handoff" : "systemd-boundary",
                      root,
                      mode: "npm",
                      reason: "candidate-failed",
                    },
                  },
                  env,
                );
              }
              await fs.appendFile(
                recoveryModulePath,
                `${sourceRuntimeImport}\nconst sentinelRuntime = await import(${JSON.stringify(sentinelRuntimeUrl.href)});\nexport const runManagedHandoffSentinelChild = sentinelRuntime.executeInstalledHandoffSentinelOperation;\n`,
              );
              if (outcome === "consumed") {
                // Model the restored Gateway consuming the first failure notice while
                // readiness is checked, before the helper annotates restoration.
                const recovery = await fs.readFile(recoveryModulePath, "utf8");
                await fs.writeFile(
                  recoveryModulePath,
                  recovery.replace(
                    "export async function waitForGatewayUpdateRecovery",
                    "async function originalRecoveryProbe",
                  ) +
                    `
export async function waitForGatewayUpdateRecovery(...args) {
  const result = await originalRecoveryProbe(...args);
  const { Client } = require(${JSON.stringify(postgresClientPath)});
  const client = new Client({ connectionString: process.env.OPENCLAW_HANDOFF_TEST_CONNECTION });
  await client.connect();
  try {
    const consumed = await client.query(${JSON.stringify(`DELETE FROM "${namespace}".gateway_restart_sentinel WHERE sentinel_key = 'current'`)});
    if (consumed.rowCount !== 1) throw new Error("expected a notice before recovery consumed it");
  } finally { await client.end(); }
  return result;
}
`,
                );
              }
              if (outcome === "unavailable") {
                const unavailable = new URL(connection!);
                unavailable.port = "1";
                env.OPENCLAW_HANDOFF_TEST_CONNECTION = unavailable.href;
              }
            },
            async beforeDisconnect() {
              const [, args] = spawnMock.mock.calls.at(-1)!;
              const { scriptPath, paramsPath } = readManagedHandoffArtifacts(args);
              for (const file of [scriptPath, paramsPath]) {
                const contents = await fs.readFile(file, "utf8");
                expect(contents).not.toContain(connection);
                expect(contents).not.toMatch(/postgres(?:ql)?:\/\//);
              }
              expect(JSON.stringify(args)).not.toContain(connection);
            },
            readSentinel(env) {
              return withEngineStoreAdmission(() => readRestartSentinelPayload(env));
            },
          });
          expect(result.log).not.toContain(connection);
          expect(result.log).not.toMatch(/postgres(?:ql)?:\/\//);
          const anchor = new DatabaseSync(anchorPath, { readOnly: true });
          try {
            expect(
              anchor.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all(),
            ).toEqual([{ name: "openclaw_engine_anchor" }]);
          } finally {
            anchor.close();
          }
          if (outcome === "completed" || outcome === "foreign") {
            expect(result.sentinel).toMatchObject({
              payload: {
                status: outcome === "completed" ? "ok" : "error",
                ts: publishedAt,
                message: "Published candidate result survives handoff.",
                stats: {
                  handoffId: outcome === "foreign" ? "another-handoff" : "systemd-boundary",
                },
              },
            });
            if (outcome === "foreign") {
              expect(result.log).toContain("belongs to another handoff");
            }
          } else {
            expect(result.state).toMatchObject({ restored: true });
            if (outcome === "unavailable" || outcome === "consumed") {
              expect(result.sentinel).toBeNull();
              expect(result.log).toContain(
                outcome === "unavailable" ? "could not be recorded" : "notice changed",
              );
            } else {
              expect(result.sentinel).toMatchObject({ payload: { status: "error" } });
            }
          }
          // The boundary fixture asserts the local handoff lease is gone before returning.
          for (const entry of await fs.readdir(fixtureEnv!.OPENCLAW_STATE_DIR!)) {
            if (!entry.endsWith(".json")) {
              continue;
            }
            const contents = await fs.readFile(
              path.join(fixtureEnv!.OPENCLAW_STATE_DIR!, entry),
              "utf8",
            );
            expect(contents).not.toContain(connection);
            expect(contents).not.toMatch(/postgres(?:ql)?:\/\//);
          }
        } finally {
          if (namespace) {
            await client.query(`DROP SCHEMA "${namespace}" CASCADE`);
          }
          await client.end();
        }
      },
      60_000,
    );
  },
);
