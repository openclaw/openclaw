import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { cronOwnerHardeningEntrypoints } from "../cron/owner-hardening-runtime.test-support.js";
import { loadCronJobsStoreWithConfigJobsReadOnly, loadCronQuarantinedJobs } from "../cron/store.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { hasActiveStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import {
  createBuiltRuntime,
  createSourceRuntime,
  ISOLATED_RUNTIME_NODE_ARGS,
  runBuiltRuntime,
  runIsolatedModuleScript,
  runSourceRuntime,
  seedPluginStateSidecar,
  seedV17AdditiveRepairDatabase,
} from "./doctor-config-preflight.process.test-support.js";
import { doctorConfigRuntimeEntrypoints } from "./doctor-config-runtime.test-support.js";

const STARTUP_REFUSAL =
  "OpenClaw startup migrations did not complete cleanly; refusing to report the gateway ready.";
const STARTUP_RECOVERY =
  'Run "openclaw doctor --fix" against the same state/config, then restart the gateway.';
const tempDirs = createFixtureLifetime();
afterAll(() => tempDirs.cleanup());
const DOCTOR_CHILD_TIMEOUT_MS = 60_000;
const LEGACY_APPROVAL_CHILD_TIMEOUT_MS = 45_000;
const doctorEnv = {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_TEST_FAST: "1",
  NO_COLOR: "1",
};
const doctorArgs = (mode?: "fix" | "repair") => [
  "doctor",
  ...(mode ? [`--${mode}`] : []),
  "--non-interactive",
  "--no-workspace-suggestions",
];
function createDoctorEnv(root: string, stateDir: string, configPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    ...doctorEnv,
  };
  delete env.NODE_ENV;
  delete env.OPENCLAW_HOME;
  delete env.VITEST;
  return env;
}

function createDoctorFixture(name: string, configInState = false) {
  const root = fs.realpathSync(tempDirs.createTempDir(`openclaw-${name}-`));
  const stateDir = path.join(root, "state");
  const configPath = path.join(configInState ? stateDir : root, "openclaw.json");
  const env = createDoctorEnv(root, stateDir, configPath);
  let runtimeRoot: string | undefined;
  const run = (args: string[], timeout: number, childEnv = env) =>
    tempDirs.track(
      runBuiltRuntime((runtimeRoot ??= createBuiltRuntime(root)), childEnv, args, timeout),
    );
  return { root, stateDir, configPath, env, run };
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readDatabase<T>(file: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function runtimeUrl(key: keyof typeof doctorConfigRuntimeEntrypoints) {
  return JSON.stringify(resolveRuntimeWorkerUrl(doctorConfigRuntimeEntrypoints[key]).href);
}

function runPreflightScript(env: NodeJS.ProcessEnv, script: string) {
  return runIsolatedModuleScript(
    env,
    `
      const fs = await import("node:fs");
      const assert = (await import("node:assert/strict")).default;
      const { runDoctorConfigPreflight } = await import(${runtimeUrl("preflight")});
      const { runStartupConfigPreflight } = await import(${runtimeUrl("startup")});
      const readConfig = () => fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8");
      const startup = () => runStartupConfigPreflight({ gateway: true, observe: false });
      const repair = async (options = {}) => {
        await runDoctorConfigPreflight({ invalidConfigNote: false, observe: false, ...options });
        const persisted = readConfig();
        const result = await startup();
        assert.equal(readConfig(), persisted, "Startup changed config after Doctor repair.");
        return { result, persisted };
      };
      ${script}
    `,
    { timeoutMs: 60_000 },
  );
}

describe("doctor invalid config process exit", () => {
  it(
    "repairs the v17 additive schema through doctor --fix",
    async () => {
      const { stateDir, configPath, run } = createDoctorFixture("doctor-v17-additive", true);
      fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
      fs.writeFileSync(configPath, "{}\n");
      const databasePath = seedV17AdditiveRepairDatabase(stateDir);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        ...doctorEnv,
      };
      const args = ["doctor", "--fix", "--non-interactive", "--yes", "--no-workspace-suggestions"];

      const first = await run(args, DOCTOR_CHILD_TIMEOUT_MS, env);
      expect(first.code, first.stderr).toBe(0);
      expect(`${first.stdout}\n${first.stderr}`).toContain(
        `v17 -> v${OPENCLAW_AGENT_SCHEMA_VERSION}`,
      );

      readDatabase(databasePath, (repaired) => {
        expect(repaired.prepare("PRAGMA user_version").get()?.user_version).toBe(
          OPENCLAW_AGENT_SCHEMA_VERSION,
        );
        for (const [table, name] of [
          ["pragma_table_info('session_conversations')", "route_context_json"],
          [
            "(SELECT name FROM sqlite_schema WHERE type = 'trigger')",
            "session_conversations_route_context_invalidate_after_update",
          ],
          [
            "(SELECT name FROM sqlite_schema WHERE type = 'index')",
            "idx_agent_transcript_event_identity_sequence",
          ],
        ] as const) {
          expect(repaired.prepare(`SELECT name FROM ${table} WHERE name = ?`).get(name)?.name).toBe(
            name,
          );
        }
      });

      const second = await run(args, DOCTOR_CHILD_TIMEOUT_MS, env);
      expect(second.code, second.stderr).toBe(0);
      expect(`${second.stdout}\n${second.stderr}`).not.toMatch(
        /Skipped agent database migration|Upgraded agent database schema/u,
      );
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS, DOCTOR_CHILD_TIMEOUT_MS),
  );

  it("keeps Doctor UI checks inside the source runtime fixture", async () => {
    const root = fs.realpathSync(tempDirs.createTempDir("openclaw-doctor-runtime-owner-"));
    const runtimeRoot = createSourceRuntime(root);
    const uiIndexPath = path.join(runtimeRoot, "dist", "control-ui", "index.html");
    fs.writeFileSync(uiIndexPath, '<script src="./assets/missing-fixture.js"></script>\n');
    const result = await tempDirs.track(
      runSourceRuntime(
        runtimeRoot,
        {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
        },
        [
          "--input-type=module",
          "--eval",
          `const { detectUiProtocolFreshnessIssues } = await import("./src/commands/doctor-ui.ts");
         console.log(JSON.stringify(await detectUiProtocolFreshnessIssues()));`,
        ],
        30_000,
      ),
    );
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { kind: "missing-assets", root: runtimeRoot, uiIndexPath, canBuild: false },
    ]);
  });

  it(
    "migrates legacy exec approvals before repairing a partially valid config",
    async () => {
      const { root, stateDir, configPath, run } = createDoctorFixture(
        "doctor-legacy-approvals",
        true,
      );
      const approvalsPath = path.join(stateDir, "exec-approvals.json");
      const knowledgePath = path.join(root, "knowledge");

      writeJson(configPath, {
        agents: {
          list: [
            {
              id: "jup",
              memorySearch: {
                enabled: true,
                provider: "auto",
                sources: ["memory", "sessions"],
                extraPaths: [knowledgePath],
                experimental: { sessionMemory: true },
                store: { vector: { enabled: false } },
                query: { maxResults: 8 },
              },
              memory: {
                search: {
                  enabled: false,
                  experimental: { sessionMemory: false },
                  query: { minScore: 0.25 },
                },
              },
              tools: { message: { allowCrossContextSend: true } },
            },
          ],
        },
      });
      writeJson(approvalsPath, {
        version: 1,
        agents: {
          jup: {
            allowlist: ["/usr/bin/rg", "=command:durable"].map((pattern) => ({
              pattern,
              source: "allow-always",
              lastUsedAt: null,
              lastUsedCommand: null,
            })),
          },
        },
      });
      const result = await run(doctorArgs("repair"), LEGACY_APPROVAL_CHILD_TIMEOUT_MS);
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result, output).toMatchObject({ code: 0, signal: null });
      for (const message of [
        "Imported legacy exec approvals policy and local socket credentials.",
        "Exec approvals updated: removed 1 older generated approval",
        "Doctor complete.",
        "Merged agents.list[0].memorySearch",
      ]) {
        expect(output).toContain(message);
      }
      for (const message of [STARTUP_RECOVERY, "Building Control UI assets"]) {
        expect(output).not.toContain(message);
      }

      const repairedConfig = JSON.parse(fs.readFileSync(configPath, "utf8")) as OpenClawConfig;
      expect(repairedConfig.agents).not.toHaveProperty("list");
      expect(repairedConfig.agents?.entries?.jup).not.toHaveProperty("memorySearch");
      expect(repairedConfig.agents?.entries?.jup?.memory?.search).toEqual({
        enabled: false,
        provider: "openai",
        sources: ["memory", "sessions"],
        extraPaths: [knowledgePath],
        experimental: { sessionMemory: false },
        store: { vector: { enabled: false } },
        query: { minScore: 0.25, maxResults: 8 },
      });

      expect(fs.existsSync(approvalsPath)).toBe(false);
      readDatabase(path.join(stateDir, "state", "openclaw.sqlite"), (database) => {
        const row = database
          .prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key = 'current'")
          .get() as { raw_json?: string } | undefined;
        expect(row?.raw_json).toContain('"pattern": "=command:durable"');
        for (const removed of ['"pattern": "/usr/bin/rg"', "lastUsedAt", "lastUsedCommand"]) {
          expect(row?.raw_json).not.toContain(removed);
        }
      });
    },
    getCliProcessTestTimeout(LEGACY_APPROVAL_CHILD_TIMEOUT_MS),
  );

  it.each([
    { engine: "sqlite", fix: false, source: "root" },
    { engine: "sqlite", fix: true, source: "root" },
    { engine: "postgres", fix: false, source: "root" },
    { engine: "postgres", fix: true, source: "root" },
    { engine: "sqlite", fix: true, source: "include" },
    { engine: "postgres", fix: true, source: "include" },
  ])(
    "reports unknown storage without creating databases for unparseable $engine $source config (fix: $fix)",
    async ({ engine, fix, source }) => {
      const { stateDir, configPath, env, run } = createDoctorFixture(
        `doctor-invalid-${engine}-${source}-${fix ? "fix" : "report"}`,
        true,
      );
      Object.assign(env, { OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_CHANNELS: "1" });
      for (const key of [
        "NODE_OPTIONS",
        "OPENCLAW_GATEWAY_PASSWORD",
        "OPENCLAW_GATEWAY_TOKEN",
        "OPENCLAW_GATEWAY_URL",
        "OPENCLAW_TEST_MISSING_DOCTOR_DSN",
        "VITEST_POOL_ID",
        "VITEST_WORKER_ID",
      ]) {
        delete env[key];
      }

      const database = {
        engine,
        ...(engine === "postgres"
          ? {
              postgres: {
                connection: {
                  source: "env",
                  provider: "default",
                  id: "OPENCLAW_TEST_MISSING_DOCTOR_DSN",
                },
              },
            }
          : {}),
      };
      const raw =
        source === "include"
          ? JSON.stringify({ database, $include: "broken.json" })
          : `{"database":${JSON.stringify(database)},"agents":{broken json`;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, raw);
      if (source === "include") {
        fs.writeFileSync(path.join(path.dirname(configPath), "broken.json"), "{broken json");
      }

      const result = await run(doctorArgs(fix ? "fix" : undefined), DOCTOR_CHILD_TIMEOUT_MS);
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result, output).toMatchObject({ code: 0, signal: null });
      for (const message of [
        "Config invalid; doctor will run with best-effort config.",
        "unknown: config could not be parsed; fix config",
        "Run `openclaw config validate` to inspect the parse error.",
        "Doctor complete.",
      ]) {
        expect(output).toContain(message);
      }
      expect(output).not.toContain("Building Control UI assets");
      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      const createdFiles = fs.readdirSync(stateDir, { recursive: true, encoding: "utf8" });
      expect(
        createdFiles.filter((file) => /\.(?:sqlite|db)(?:$|-(?:wal|shm|journal)$)/u.test(file)),
      ).toEqual([]);
      expect(createdFiles.filter((file) => file.includes(".clobbered."))).toEqual([]);
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
  );

  it.each([
    { engine: "sqlite", lint: true },
    { engine: "postgres", lint: true },
    { engine: "sqlite", lint: false },
    { engine: "postgres", lint: false },
  ])(
    "preserves the JSON failure envelope without opening storage for malformed $engine config (lint: $lint)",
    async ({ engine, lint }) => {
      const { stateDir, configPath, run } = createDoctorFixture(
        `doctor-invalid-lint-${engine}`,
        true,
      );
      const raw = `{"database":{"engine":"${engine}"}, broken`;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, raw);

      const result = await run(
        ["doctor", ...(lint ? ["--lint"] : []), "--json"],
        DOCTOR_CHILD_TIMEOUT_MS,
      );
      expect(result, result.stderr).toMatchObject({ code: lint ? 2 : 0, signal: null });
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ schemaVersion: 1, ok: false, checksRun: 0 });
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining("unknown: config could not be parsed"),
        }),
      );
      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
      expect(
        fs
          .readdirSync(stateDir, { recursive: true, encoding: "utf8" })
          .filter((file) => /\.(?:sqlite|db)(?:$|-(?:wal|shm|journal)$)/u.test(file)),
      ).toEqual([]);
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
  );

  it.each(["sqlite", "postgres"] as const)(
    "leaves prefixed %s config untouched while a live Gateway owns the target",
    async (engine) => {
      const { stateDir, configPath, run } = createDoctorFixture(
        `doctor-prefix-owner-${engine}`,
        true,
      );
      const ownerChild = spawn(
        process.execPath,
        ["-e", "setTimeout(() => {}, 120_000)", "src/entry.ts", "gateway"],
        { cwd: path.resolve("."), stdio: "ignore" },
      );
      try {
        const raw = `synthetic warning\n${JSON.stringify({
          database: {
            engine,
            ...(engine === "postgres"
              ? {
                  postgres: {
                    connection: { source: "env", provider: "default", id: "MISSING_DSN" },
                  },
                }
              : {}),
          },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        })}\n`;
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, raw);
        const startTime = getFileLockProcessStartTime(ownerChild.pid!);
        writeJson(path.join(resolveGatewayLockDir(stateDir), "gateway.state.lock"), {
          pid: ownerChild.pid,
          ownerId: "doctor-prefix-owner",
          createdAt: new Date().toISOString(),
          configPath,
          port: 18720,
          stateDir,
          ...(startTime !== null ? { startTime } : {}),
        });

        const result = await run(doctorArgs("fix"), DOCTOR_CHILD_TIMEOUT_MS);
        const output = `${result.stderr}\n${result.stdout}`;
        expect(result, output).toMatchObject({ code: 0, signal: null });
        expect(output).toContain("exclusive offline");
        expect(output).toContain("unknown: config could not be parsed");
        expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
        const files = fs.readdirSync(stateDir, { recursive: true, encoding: "utf8" });
        expect(files.filter((file) => file.includes(".clobbered."))).toEqual([]);
        expect(
          files.filter((file) => /\.(?:sqlite|db)(?:$|-(?:wal|shm|journal)$)/u.test(file)),
        ).toEqual([]);
      } finally {
        await tempDirs.verifyCleanup(() => stopChildProcess(ownerChild, 5_000));
      }
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
  );

  it(
    "recovers a non-JSON prefix through doctor --fix before normal database checks",
    async () => {
      const { configPath, env, run } = createDoctorFixture("doctor-prefixed-config-fix", true);
      Object.assign(env, { OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_CHANNELS: "1" });
      const config = {
        database: { engine: "sqlite" },
        gateway: { mode: "local" },
        plugins: { enabled: false },
      };
      const raw = `synthetic warning\n${JSON.stringify(config)}\n`;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, raw);

      const result = await run(doctorArgs("fix"), DOCTOR_CHILD_TIMEOUT_MS);
      const output = `${result.stderr}\n${result.stdout}`;

      expect(result, output).toMatchObject({ code: 0, signal: null });
      expect(output).toContain("Removed non-JSON prefix from openclaw.json.");
      expect(output).toContain("Doctor complete.");
      expect(output).not.toContain("unknown: config could not be parsed");
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject(config);
      const clobbered = fs
        .readdirSync(path.dirname(configPath))
        .filter((file) => file.startsWith(`${path.basename(configPath)}.clobbered.`));
      expect(clobbered).toHaveLength(1);
      for (const file of clobbered) {
        expect(fs.readFileSync(path.join(path.dirname(configPath), file), "utf8")).toBe(raw);
      }
    },
    getCliProcessTestTimeout(DOCTOR_CHILD_TIMEOUT_MS),
  );
});

describe("Doctor repair followed by gateway readiness", () => {
  it("serves canonical state after Doctor repairs cron and preserves retired plugin sidecars", async () => {
    const nodeExecutable = resolveTestNodeExecPath();
    const runtimeRoot = createBuiltRuntime(
      tempDirs.createTempDir("openclaw-cron-upgrade-runtime-"),
    );
    const instance = await createOpenClawTestInstance({
      name: "cron-upgrade-ready",
      cwd: runtimeRoot,
      gatewayCommandPrefix: [nodeExecutable],
      entrypoint: [...ISOLATED_RUNTIME_NODE_ARGS, path.join(runtimeRoot, "dist", "entry.js")],
      startTimeoutMs: 30_000,
      stopTimeoutMs: 1_500,
      env: {
        NODE_ENV: undefined,
        ...doctorEnv,
        OPENCLAW_HOME: undefined,
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        VITEST: undefined,
        // Preserve full startup; the shared fixture otherwise skips sidecar readiness.
        OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN,
        OPENCLAW_GATEWAY_PASSWORD: process.env.OPENCLAW_GATEWAY_PASSWORD,
        OPENCLAW_SKIP_PROVIDERS: process.env.OPENCLAW_SKIP_PROVIDERS,
        OPENCLAW_SKIP_GMAIL_WATCHER: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
        OPENCLAW_SKIP_CRON: process.env.OPENCLAW_SKIP_CRON,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER,
        OPENCLAW_SKIP_CANVAS_HOST: process.env.OPENCLAW_SKIP_CANVAS_HOST,
        OPENCLAW_TEST_MINIMAL_GATEWAY: process.env.OPENCLAW_TEST_MINIMAL_GATEWAY,
      },
    });
    const { env, port, stateDir } = instance;
    const storePath = path.join(stateDir, "cron", "jobs.json");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");

    try {
      await instance.state.writeConfig({
        agents: { entries: { main: {} } },
        gateway: { mode: "local", port, auth: { mode: "none" } },
      });
      seedPluginStateSidecar(stateDir, 2_000);
      const sidecarPath = path.join(stateDir, "plugin-state", "state.sqlite");
      const preservedSidecar = fs.readFileSync(sidecarPath);
      const readPluginState = () =>
        readDatabase(databasePath, (database) =>
          database
            .prepare(
              "SELECT value_json, created_at FROM plugin_state_entries WHERE plugin_id = 'discord' AND namespace = 'components' AND entry_key = 'interaction:1'",
            )
            .get(),
        );
      const job = {
        name: "SQLite automation",
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 1,
        schedule: { kind: "cron", expr: "0 9 * * *" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      };
      const jobs = [
        { ...job, id: "valid-job" },
        { ...job, id: "invalid-state-job", state: { nextRunAtMs: -1 } },
        { ...job, id: "invalid-trigger-job", trigger: { script: [] } },
      ];
      const database = new DatabaseSync(databasePath);
      try {
        // Raw rows preserve corruption that the current store writer rejects.
        const insert = database.prepare(`
          INSERT INTO cron_jobs (
            store_key, job_id, name, enabled, payload_kind, job_json, state_json,
            runtime_updated_at_ms, sort_order, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const [index, { state, updatedAtMs, ...definition }] of jobs.entries()) {
          insert.run(
            storePath,
            definition.id,
            definition.name,
            1,
            definition.payload.kind,
            JSON.stringify({ ...definition, state: {} }),
            JSON.stringify(state),
            updatedAtMs,
            index,
            updatedAtMs,
          );
        }
      } finally {
        database.close();
      }

      const doctor = await instance.cli(doctorArgs("fix"), {
        execPath: nodeExecutable,
        timeoutMs: 30_000,
      });
      const doctorOutput = `${doctor.stdout}\n${doctor.stderr}`;
      expect(doctor.code, doctorOutput).toBe(0);
      expect(doctorOutput).not.toContain("Building Control UI assets");
      expect(doctorOutput).not.toContain("Left plugin-state sidecar in place");
      expect(fs.readFileSync(sidecarPath)).toEqual(preservedSidecar);
      expect(readPluginState()).toEqual({ value_json: '{"ok":false}', created_at: 2_000 });
      const backupNames = fs
        .readdirSync(path.dirname(databasePath))
        .filter((name) => name.startsWith("openclaw.sqlite.doctor-cron-") && name.endsWith(".bak"));
      expect(backupNames.length).toBeGreaterThan(0);
      readDatabase(path.join(path.dirname(databasePath), backupNames.toSorted()[0]!), (backup) => {
        expect(backup.prepare("SELECT job_id FROM cron_jobs ORDER BY sort_order").all()).toEqual([
          { job_id: "valid-job" },
          { job_id: "invalid-state-job" },
          { job_id: "invalid-trigger-job" },
        ]);
      });

      try {
        await instance.startGateway();
        const response = await fetch(`http://127.0.0.1:${port}/readyz`);
        await expect(response.json()).resolves.toMatchObject({ ready: true, failing: [] });
        const logs = instance.logs();
        expect(logs).not.toContain("Left plugin-state sidecar in place");
        expect(logs).not.toContain(STARTUP_REFUSAL);
        const status = await instance.cli(["gateway", "call", "status", "--json"], {
          execPath: nodeExecutable,
        });
        expect(status.code, status.stdout + "\n" + status.stderr).toBe(0);
        expect(JSON.parse(status.stdout).startupMigrationWarning).toBeUndefined();
        expect(fs.readFileSync(sidecarPath)).toEqual(preservedSidecar);
      } finally {
        await instance.stopGateway();
      }
      expect(readPluginState()).toEqual({ value_json: '{"ok":false}', created_at: 2_000 });

      const loaded = await loadCronJobsStoreWithConfigJobsReadOnly(storePath, env);
      expect(loaded.store.jobs.map((entry) => entry.id)).toContain("valid-job");
      // SQLite config decoding quarantines the trigger before Doctor validates runtime state.
      expect(
        (await loadCronQuarantinedJobs(storePath, env)).map((entry) => ({
          sourceIndex: entry.sourceIndex,
          reason: entry.reason,
          id: entry.job?.id,
        })),
      ).toEqual([
        { sourceIndex: 2, reason: "invalid-trigger", id: "invalid-trigger-job" },
        { sourceIndex: 1, reason: "invalid-state", id: "invalid-state-job" },
      ]);
      expect(fs.existsSync(storePath)).toBe(false);
    } finally {
      await instance.cleanup();
    }
  }, 45_000);

  it("admits stable upgrade state after Doctor repairs config, schema, and device identity", async () => {
    const { stateDir, configPath, env } = createDoctorFixture("stable-upgrade-ready");
    const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
    writeJson(configPath, {
      meta: {
        lastTouchedAt: "2026-08-01T00:00:00.000Z",
        lastTouchedVersion: "2026.7.1-2",
      },
      agents: { defaults: { heartbeat: { skipWhenBusy: true } }, list: [{ id: "main" }] },
      gateway: { mode: "local", auth: { mode: "none" } },
    });
    seedPluginStateSidecar(stateDir, 4_000);
    // Initialization and repair must share the same database module instance.
    const stateDatabaseUrl = resolveRuntimeWorkerUrl(
      cronOwnerHardeningEntrypoints.stateDatabase,
    ).href;
    const identityStoreUrl = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "../infra/device-identity-store",
      distWorkerPath: "infra/device-identity-store.js",
    }).href;
    const script = `
      const path = await import("node:path");
      const { DatabaseSync } = await import("node:sqlite");
      const { closeOpenClawStateDatabase, openOpenClawStateDatabase } =
        await import(${JSON.stringify(stateDatabaseUrl)});
      const { readStoredDeviceIdentityReadOnly } = await import(${JSON.stringify(identityStoreUrl)});
      openOpenClawStateDatabase({ env: process.env });
      closeOpenClawStateDatabase();
      const oldDatabase = new DatabaseSync(${JSON.stringify(databasePath)});
      oldDatabase.exec("ALTER TABLE apns_registrations DROP COLUMN relay_origin");
      oldDatabase.close();
      const legacyIdentityPath = path.join(${JSON.stringify(stateDir)}, "identity", "device.json");
      fs.mkdirSync(path.dirname(legacyIdentityPath), { recursive: true });
      const legacyIdentityRaw = JSON.stringify({
        deviceId: "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
        publicKey: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
        privateKey: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        createdAtMs: 1700000000000,
      });
      fs.writeFileSync(legacyIdentityPath, legacyIdentityRaw);
      const { result, persisted } = await repair({
        doctorOnlyStateMigrations: true, repairPrefixedConfig: true,
      });
      const config = JSON.parse(persisted);
      const repairedDatabase = new DatabaseSync(${JSON.stringify(databasePath)}, { readOnly: true });
      const columns = repairedDatabase.prepare("PRAGMA table_info(apns_registrations)").all();
      const identity = readStoredDeviceIdentityReadOnly();
      const pluginState = repairedDatabase
        .prepare("SELECT value_json, created_at FROM plugin_state_entries WHERE plugin_id = 'discord' AND namespace = 'components' AND entry_key = 'interaction:1'")
        .get();
      repairedDatabase.close();
      assert.equal(result.snapshot.valid, true);
      assert.equal(Object.hasOwn(config.meta ?? {}, "lastTouchedAt"), false);
      assert.equal(Object.hasOwn(config.agents?.defaults?.heartbeat ?? {}, "skipWhenBusy"), false);
      assert.equal(columns.some((column) => column.name === "relay_origin"), true);
      assert.equal(identity?.deviceId, "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c");
      assert.equal(fs.readFileSync(legacyIdentityPath, "utf8"), legacyIdentityRaw);
      assert.deepEqual({ ...pluginState }, { value_json: '{"ok":false}', created_at: 4_000 });
      console.log("__READY__");
    `;

    const result = await runPreflightScript(env, script);
    expect(result.stdout, `${result.stderr}\n${result.stdout}`).toContain("__READY__");
    expect(fs.existsSync(path.join(stateDir, "plugin-state", "state.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "plugin-state", "state.sqlite.migrated"))).toBe(false);
    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
  }, 75_000);

  it("leaves retired Codex idle settings to Doctor and preserves connection config", async () => {
    const { root, stateDir, configPath, env } = createDoctorFixture("codex-startup-config");
    const appServer = {
      transport: "websocket",
      command: path.join(root, "custom-codex"),
      args: ["app-server", "--listen", "stdio://"],
      url: "ws://127.0.0.1:39175",
      headers: { "X-Codex-Startup": "synthetic-header" },
      requestTimeoutMs: 120_000,
      mode: "guardian",
    };
    const pluginConfig = {
      discovery: { enabled: false },
      sessionCatalog: { enabled: false },
      appServer,
    };
    const retiredSettings = {
      turnCompletionIdleTimeoutMs: 60_000,
      turnAssistantCompletionIdleTimeoutMs: 10_000,
      postToolRawAssistantCompletionIdleTimeoutMs: 300_000,
    };
    const config = {
      meta: { migrations: { webhookListeners: true } },
      agents: {
        defaults: { timeoutSeconds: 0 },
        entries: { main: { workspace: path.join(root, "workspace") } },
      },
      gateway: { mode: "local", auth: { mode: "none" } },
      plugins: {
        allow: ["codex"],
        entries: {
          codex: {
            enabled: true,
            config: { ...pluginConfig, appServer: { ...appServer, ...retiredSettings } },
          },
        },
      },
    } satisfies OpenClawConfig;
    Object.assign(env, {
      CODEX_HOME: path.join(root, ".codex"),
      OPENCLAW_OAUTH_DIR: path.join(stateDir, "credentials"),
      OPENCLAW_TEST_HOME: root,
    });
    // Use the pretest-built bundled artifacts, not the parent worker's source-tree override.
    for (const key of [
      "NODE_ENV",
      "NODE_OPTIONS",
      "OPENCLAW_AGENT_DIR",
      "OPENCLAW_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_HOME",
      "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
      "OPENCLAW_UPDATE_IN_PROGRESS",
      "VITEST",
      "VITEST_POOL_ID",
      "VITEST_WORKER_ID",
    ]) {
      delete env[key];
    }

    writeJson(configPath, config);
    const script = `
      const { readConfigFileSnapshot } = await import(${runtimeUrl("configIO")});
      const { hasActiveStartupMigrationLease } = await import(${runtimeUrl("checkpoint")});
      const expectedPluginConfig = ${JSON.stringify(pluginConfig)};
      const retiredKeys = ${JSON.stringify(Object.keys(retiredSettings))};
      const initial = await readConfigFileSnapshot({ observe: false });
      assert.equal(initial.valid, false);
      for (const key of retiredKeys) {
        assert.ok(initial.issues.some((issue) =>
          issue.path === "plugins.entries.codex.config.appServer" && issue.message.includes(key)
        ), JSON.stringify(initial.issues));
      }
      const original = readConfig();
      assert.equal((await startup()).snapshot.valid, false);
      assert.equal(readConfig(), original);
      assert.equal(fs.existsSync(${JSON.stringify(`${configPath}.bak`)}), false);
      let firstPersisted;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { result, persisted } = await repair();
        assert.equal(result.snapshot.valid, true);
        const persistedConfig = JSON.parse(persisted);
        for (const source of [result.snapshot.sourceConfig, persistedConfig]) {
          assert.deepEqual(source.plugins.entries.codex.config, expectedPluginConfig);
          assert.deepEqual(source.agents, ${JSON.stringify(config.agents)});
        }
        const runtime = result.snapshot.config;
        const runtimeAppServer = runtime.plugins.entries.codex.config.appServer;
        for (const [key, value] of Object.entries(expectedPluginConfig.appServer)) {
          assert.deepEqual(runtimeAppServer[key], value);
        }
        for (const key of retiredKeys) {
          assert.equal(Object.hasOwn(runtimeAppServer, key), false);
        }
        assert.equal(runtime.agents.defaults.timeoutSeconds, 0);
        assert.equal(hasActiveStartupMigrationLease(), false);
        if (attempt === 0) {
          firstPersisted = persisted;
        } else {
          assert.equal(persisted, firstPersisted);
        }
      }
      console.log("__READY__");
    `;

    const result = await runPreflightScript(env, script);
    expect(result.stdout, `${result.stderr}\n${result.stdout}`).toContain("__READY__");
    expect(hasActiveStartupMigrationLease({ env })).toBe(false);
  }, 75_000);

  it("preserves legacy state and orphan sidecars when a live gateway owns the state directory", async () => {
    const { stateDir, configPath, env, run } = createDoctorFixture("live-owner-ready");
    // Windows validates live owners by gateway argv when start time is unavailable.
    const ownerChild = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 120_000)", "src/entry.ts", "gateway"],
      { cwd: path.resolve("."), stdio: "ignore" },
    );

    try {
      writeJson(configPath, { gateway: { mode: "local", auth: { mode: "none" } } });
      const legacyAgentDir = path.join(stateDir, "agent");
      const legacyArtifactPath = path.join(legacyAgentDir, "auth-profiles.json");
      writeJson(legacyArtifactPath, { profiles: {} });
      // Live-owner refusal must precede quarantine of this orphan WAL.
      const sharedStateDbDir = path.join(stateDir, "state");
      fs.mkdirSync(sharedStateDbDir, { recursive: true });
      const orphanWalPath = path.join(sharedStateDbDir, "openclaw.sqlite-wal");
      fs.writeFileSync(orphanWalPath, Buffer.alloc(64, 1));
      const lockDir = resolveGatewayLockDir(stateDir);
      const startTime = getFileLockProcessStartTime(ownerChild.pid!);
      writeJson(path.join(lockDir, "gateway.state.lock"), {
        pid: ownerChild.pid,
        ownerId: "live-owner-refusal-test",
        createdAt: new Date().toISOString(),
        configPath,
        port: 18720,
        stateDir,
        ...(startTime !== null ? { startTime } : {}),
      });
      const result = await run(
        ["gateway", "run", "--port", "18720", "--allow-unconfigured"],
        30_000,
      );
      const output = `${result.stderr}\n${result.stdout}`;

      expect(fs.existsSync(legacyArtifactPath), output).toBe(true);
      expect(fs.existsSync(path.join(stateDir, "agents", "main", "agent")), output).toBe(false);
      expect(fs.readdirSync(sharedStateDbDir), output).toEqual(["openclaw.sqlite-wal"]);
      expect(result.code, output).toBe(78);
      expect(result.stderr, output).toContain("already owns this state directory");
      expect(hasActiveStartupMigrationLease({ env })).toBe(false);
    } finally {
      await tempDirs.verifyCleanup(() => stopChildProcess(ownerChild, 5_000));
    }
  }, 45_000);

  it("reloads tool ownership after updater-managed manifest repair", async () => {
    const { root, configPath, env } = createDoctorFixture("updater-manifest-repair");
    const pluginId = "updater-tool-owner";
    const pluginDir = path.join(root, "plugins", pluginId);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const config = {
      gateway: { mode: "local", auth: { mode: "none" } },
      plugins: {
        load: { paths: [pluginDir] },
        entries: { [pluginId]: { enabled: true } },
      },
    } satisfies OpenClawConfig;
    env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;

    fs.mkdirSync(pluginDir, { recursive: true });
    writeJson(configPath, config);
    writeJson(path.join(pluginDir, "package.json"), {
      name: `@openclaw/${pluginId}`,
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"] },
    });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n");
    writeJson(manifestPath, {
      id: pluginId,
      tools: ["updater_tool"],
      configSchema: { type: "object" },
    });

    // Repair and observation must use the same metadata scope and invalidation owner.
    const result = await runIsolatedModuleScript(
      env,
      `
        const fs = await import("node:fs");
        const assert = (await import("node:assert/strict")).default;
        const { loadAndMaybeMigrateDoctorConfig } = await import(${runtimeUrl("configFlow")});
        const { getCurrentPluginMetadataSnapshot } =
          await import(${runtimeUrl("metadataSnapshot")});
        const { runLegacyPluginManifestHealth } = await import(${runtimeUrl("stateHealth")});
        const { createDoctorPrompter } = await import(${runtimeUrl("prompter")});
        const options = { nonInteractive: true, repair: true };
        const runtime = {
          log: () => {}, warn: () => {}, error: () => {},
          exit: (code) => { throw new Error("doctor exited " + code); },
        };
        const prompter = createDoctorPrompter({ runtime, options });
        await using configResult = await loadAndMaybeMigrateDoctorConfig({
          options, confirm: async () => false, runtime, prompter,
        });
        const readToolOwners = () =>
          configResult.runWithPluginMetadataSnapshot(
            { config: configResult.cfg },
            () => [...(getCurrentPluginMetadataSnapshot({ config: configResult.cfg })
              ?.owners.contracts.get("tools") ?? [])],
          );
        const before = readToolOwners();
        await runLegacyPluginManifestHealth({
          cfg: configResult.cfg,
          runtime,
          prompter,
          invalidatePluginMetadataSnapshot: configResult.invalidatePluginMetadataSnapshot,
        });
        const after = readToolOwners();
        const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(manifestPath)}, "utf8"));
        assert.deepEqual({
          retainedBaseSnapshot: configResult.pluginMetadataSnapshot !== undefined,
          before,
          after,
          legacyTools: manifest.tools,
          contractTools: manifest.contracts?.tools,
        }, {
          retainedBaseSnapshot: false, before: [], after: [${JSON.stringify(pluginId)}],
          legacyTools: undefined, contractTools: ["updater_tool"],
        });
        console.log("__READY__");
      `,
      { timeoutMs: 60_000 },
    );
    expect(result.stdout, `${result.stderr}\n${result.stdout}`).toContain("__READY__");
  }, 90_000);
});
