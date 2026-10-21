import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "../commands/doctor-config-preflight.process.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";
import { cliRecoveryEntrypoints, doctorOutputEntrypoints } from "./cli-entrypoint.test-support.js";
import { getCliProcessTestTimeout } from "./cli-process-child.test-helpers.js";
import { cliChildEnv, cliOutputScript } from "./cli-process-fixture.test-support.js";

const childTimeout = 60_000;
const doctorEntrypoint = resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli);
const packageDir = path.dirname(fileURLToPath(doctorEntrypoint));
beforeAll(() => {
  expect(doctorEntrypoint.pathname, "Prepared Doctor runtime required").toMatch(/\.js$/);
});
const tempDirs = createFixtureLifetime();
afterEach(() => tempDirs.cleanup());
const runtimeDirs = createFixtureLifetime();
let doctorRuntime: { root: string; cache: string } | undefined;

afterAll(() => {
  doctorRuntime = undefined;
  return runtimeDirs.cleanup();
});

function runDoctor(params: {
  root: string;
  configPath: string;
  repair?: boolean;
  env?: NodeJS.ProcessEnv;
}) {
  // Share immutable package assets only; every invocation retains its own state and tracked child.
  doctorRuntime ??= {
    root: createBuiltRuntime(runtimeDirs.createTempDir("openclaw-doctor-runtime-"), packageDir),
    cache: runtimeDirs.createTempDir("oc-doctor-cache-"),
  };
  const child = runBuiltRuntime(
    doctorRuntime.root,
    cliChildEnv(params.root, {
      ...process.env,
      HOME: params.root,
      USERPROFILE: params.root,
      NODE_ENV: undefined,
      OPENCLAW_CONFIG_PATH: params.configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_HIDE_BANNER: "1",
      OPENCLAW_HOME: undefined,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_STATE_DIR: path.join(params.root, "state"),
      OPENCLAW_TEST_FAST: "1",
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      ...params.env,
      NODE_DISABLE_COMPILE_CACHE: undefined,
      NODE_COMPILE_CACHE: doctorRuntime.cache,
    }),
    [
      "doctor",
      ...(params.repair ? ["--fix"] : []),
      "--non-interactive",
      "--no-workspace-suggestions",
      "--no-color",
    ],
    childTimeout,
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return tempDirs.track(runtimeDirs.track(child));
}

function writeJson(filename: string, value: unknown) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(label: string) {
  const root = tempDirs.createTempDir(`openclaw-doctor-${label}-`);
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  return { root, stateDir, configPath, env: { OPENCLAW_STATE_DIR: stateDir } };
}

function expectExit(
  result: { signal: string | null; code: number | null; stderr: string; stdout: string },
  code = 0,
) {
  const output = `${result.stderr}\n${result.stdout}`;
  expect(result.signal, output).toBeNull();
  expect(result.code, output).toBe(code);
  return output;
}

function sessionNode(agentId: string) {
  return {
    session_key: `agent:${agentId}:proof`,
    current_session_id: `${agentId}-proof-session`,
    entry_json: "{}",
    updated_at: 1,
  };
}

it("refuses an unfenced schema bump without publication metadata before CLI debug capture can write state", async () => {
  const { root, configPath, env: stateEnv } = fixture("update-schema");
  const env = { ...stateEnv, OPENCLAW_CONFIG_PATH: configPath };
  fs.writeFileSync(configPath, "{}\n");
  const shared = openOpenClawStateDatabase({ env }).path;
  createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env });
  closeOpenClawStateDatabaseForTest();
  const legacy = new DatabaseSync(shared);
  legacy.exec(
    `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}; UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}; DROP TABLE config_machine_state;`,
  );
  legacy.close();
  const databaseBefore = fs.readFileSync(shared);
  const sidecarsBefore = ["-wal", "-shm"].map((suffix) => fs.existsSync(`${shared}${suffix}`));
  const configBefore = fs.readFileSync(configPath);

  const result = await runDoctor({
    root,
    configPath,
    repair: true,
    env: {
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_DEBUG_PROXY_ENABLED: "1",
      OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    },
  });
  expect(
    ["-wal", "-shm"].map((suffix) => fs.existsSync(`${shared}${suffix}`)),
    result.stderr,
  ).toEqual(sidecarsBefore);
  expect(fs.readFileSync(shared).equals(databaseBefore), result.stderr).toBe(true);
  expect(fs.readFileSync(configPath)).toEqual(configBefore);
  expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(1);
  expect(`${result.stderr}\n${result.stdout}`).toContain(
    "Doctor refused update-time schema repair driven by OpenClaw 2026.9.2",
  );
});

it(
  "reports deferred Doctor-only state after config refusal, then converges",
  async () => {
    const { root, stateDir, configPath } = fixture("deferred-state");
    const workspaceDir = path.join(root, "workspace");
    const workspaceSource = path.join(workspaceDir, "openclaw-workspace-state.json");
    const tuiSource = path.join(stateDir, "tui", "last-session.json");
    const agentSource = path.join(stateDir, "agent", "auth.json");
    const invalidConfig = {
      gatway: { port: 12345 },
      gateway: {
        mode: "remote",
        remote: { url: "ws://127.0.0.1:1", token: "fixture-token" },
      },
      agents: {
        ownership: "explicit",
        defaults: { heartbeat: { every: 5 } },
        entries: { primary: { workspace: workspaceDir }, secondary: {} },
      },
    };
    writeJson(configPath, invalidConfig);
    writeJson(workspaceSource, { version: 1, setupCompletedAt: "2026-08-01T00:00:00.000Z" });
    writeJson(tuiSource, { global: { sessionKey: "agent:main:main", updatedAt: 1 } });
    writeJson(agentSource, {});
    const sources = [configPath, workspaceSource, tuiSource, agentSource];
    const before = sources.map((source) => fs.readFileSync(source));

    const refusedOutput = expectExit(await runDoctor({ root, configPath, repair: true }), 1);
    expect(refusedOutput.match(/Legacy state deferred/g) ?? [], refusedOutput).toHaveLength(1);
    expect(refusedOutput).toContain("Workspace setup and attestations");
    expect(refusedOutput).toContain("TUI last-session pointers");
    expect(refusedOutput).toContain(
      "Deferred legacy agent/session migration: select an agent owner",
    );
    expect(refusedOutput).toContain('rerun "openclaw doctor --fix"');
    expect(sources.map((source) => fs.readFileSync(source))).toEqual(before);
    expect(fs.readdirSync(workspaceDir)).toEqual(["openclaw-workspace-state.json"]);
    expect(fs.readdirSync(path.dirname(tuiSource))).toEqual(["last-session.json"]);

    writeJson(configPath, {
      ...invalidConfig,
      agents: {
        ...invalidConfig.agents,
        defaults: { heartbeat: { every: "30m" }, systemAgent: { agentId: "primary" } },
      },
    });
    expectExit(await runDoctor({ root, configPath, repair: true }));
    expect(sources.slice(1).map(fs.existsSync)).toEqual([false, false, false]);
    expect(fs.existsSync(path.join(stateDir, "agents", "primary", "agent", "auth.json"))).toBe(
      true,
    );
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).not.toHaveProperty("gatway");

    const cleanOutput = expectExit(await runDoctor({ root, configPath, repair: true }));
    expect(cleanOutput).not.toContain("Legacy state deferred");
    expect(cleanOutput).not.toContain("Legacy state detected");
  },
  getCliProcessTestTimeout(childTimeout, childTimeout, childTimeout),
);

it("fails repair when session import leaves a startup-blocking legacy store", async () => {
  const { root, stateDir, configPath } = fixture("session-convergence");
  const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const original = Buffer.from('{"agent:main:legacy":');
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  writeJson(configPath, { session: { typingMode: "thinking" } });
  fs.writeFileSync(storePath, original);

  const output = expectExit(await runDoctor({ root, configPath, repair: true }), 1);
  expect(output).toContain("Legacy session store requires migration");
  expect(output).toContain("openclaw doctor --fix");
  expect(output).not.toContain("Doctor complete.");
  expect(fs.readFileSync(storePath)).toEqual(original);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  expect(config).toMatchObject({
    agents: { defaults: { typingMode: "thinking" } },
  });
  expect(config).not.toHaveProperty("session.typingMode");
}, 120_000);

it(
  "explains and preserves retained custom agent databases in preview and repair",
  async () => {
    for (const repair of [false, true]) {
      const { root, stateDir, configPath, env } = fixture(
        `retained-database-${repair ? "repair" : "preview"}`,
      );
      fs.mkdirSync(stateDir, { recursive: true });
      writeJson(configPath, {
        agents: {
          ownership: "explicit",
          entries: { main: {} },
        },
      });
      openOpenClawAgentDatabase({ agentId: "main", env });
      const retained = { agentId: "retired", path: path.join(stateDir, "retired.sqlite") };
      const foreign = {
        agentId: "external",
        path: path.join(root, "external\n\u001b[31mforged", "retired.sqlite"),
      };
      const sanitizedExternalPath = path.join(root, "externalforged", "retired.sqlite");
      const retainedDatabases = [retained, foreign];
      for (const databaseCase of retainedDatabases) {
        const database = openOpenClawAgentDatabase({ ...databaseCase, env });
        database.db
          .prepare(
            `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(...Object.values(sessionNode(databaseCase.agentId)));
      }
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();

      const output = expectExit(await runDoctor({ root, configPath, repair }));
      expect(output).toContain('Retained unconfigured agent database "retired" at');
      expect(output).toContain(retained.path);
      expect(output).toContain("Doctor will not remove it automatically because it may contain");
      expect(output).toContain("retired or manually managed agent state.");
      expect(output).not.toContain('Retained unconfigured agent database "main"');
      expect(output).toContain("Skipped foreign agent database");
      expect(output).toContain(sanitizedExternalPath);
      expect(output).not.toContain(foreign.path);
      for (const databaseCase of retainedDatabases) {
        const db = new DatabaseSync(databaseCase.path, { readOnly: true });
        try {
          expect(
            db
              .prepare(
                `SELECT session_key, current_session_id, entry_json, updated_at
                 FROM session_nodes WHERE session_key = ?`,
              )
              .get(`agent:${databaseCase.agentId}:proof`),
          ).toEqual(sessionNode(databaseCase.agentId));
        } finally {
          db.close();
        }
      }
      const registeredDatabases = listOpenClawRegisteredAgentDatabases({ env });
      expect(registeredDatabases).toContainEqual(expect.objectContaining(retained));
      expect(registeredDatabases).not.toContainEqual(expect.objectContaining(foreign));
    }
  },
  getCliProcessTestTimeout(childTimeout, childTimeout),
);

it.each([
  { name: "lint JSON", args: ["--lint", "--json"], exitCode: 1 },
  { name: "post-upgrade JSON", args: ["--post-upgrade", "--json"], exitCode: 1 },
])("drains the whole pipe before exiting for $name", ({ args, exitCode }) => {
  const root = tempDirs.createTempDir("openclaw-doctor-output-");
  const payload = { ok: false, findings: [{ level: "error", message: "x".repeat(1024 * 1024) }] };
  const maintenance = resolveRuntimeWorkerUrl(doctorOutputEntrypoints.maintenance);
  const oneShotExit = resolveRuntimeWorkerUrl(doctorOutputEntrypoints.oneShotExit);
  const report = '{ ok: false, findings: [{ level: "error", message: "x".repeat(1024 * 1024) }] }';
  const script = cliOutputScript({
    registration: [maintenance.href, "registerMaintenanceCommands"],
    exitUrl: oneShotExit.href,
    argv: ["doctor", ...args],
    modules: {
      "/doctor-lint.js": `export async function runDoctorLintCli(runtime) { runtime.writeJson(${report}); return 1; }`,
      "/doctor-post-upgrade.js": `export async function runPostUpgradeProbes() { return ${report}; }`,
    },
  });
  const result = spawnNodeEvalSync(script, {
    env: cliChildEnv(root, {
      PATH: path.dirname(process.execPath),
      NO_COLOR: "1",
    }),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });

  expect(result.error).toBeUndefined();
  expect(result, result.stderr).toMatchObject({ signal: null, status: exitCode, stderr: "" });
  expect(result.stdout).toBe(`${JSON.stringify(payload, null, 2)}\n`);
});
