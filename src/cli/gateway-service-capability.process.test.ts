import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  createBuiltRuntime,
  createSourceRuntime,
  runBuiltRuntime,
  runSourceRuntime,
} from "../commands/doctor-config-preflight.process.test-support.js";
import { listDirectoryTreeStrictSync } from "../infra/directory-walk.js";
import { acquireFileLockSync } from "../infra/file-lock-manager.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { getCliProcessTestTimeout } from "./cli-process-child.test-helpers.js";

const CLI_CHILD_TIMEOUT_MS = 60_000;
const tempDirs = createFixtureLifetime();
afterEach(() => tempDirs.cleanup());

function createFixture() {
  const root = tempDirs.createTempDir("openclaw-service-capability-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(configPath, '{"gateway":{"mode":"local"}}\n');
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_NO_RESPAWN: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_HIDE_BANNER: "1",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DEBUG_PROXY_ENABLED: "1",
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
  };
  const databasePath = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};
    UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};`);
  legacy.close();
  const entry = fileURLToPath(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli));
  const source = /\.[cm]?ts$/u.test(entry);
  const runtimeRoot = source
    ? createSourceRuntime(root)
    : createBuiltRuntime(root, path.dirname(entry));
  const lockPath = resolveGatewayStateOwnerPath(databasePath);
  const operationsPath = path.join(root, "probe-operations.jsonl");
  const preloadPath = path.join(root, "guard-probe.cjs");
  fs.writeFileSync(
    preloadPath,
    `const fs = require("node:fs");
const path = require("node:path");
const threads = require("node:worker_threads");
const append = fs.appendFileSync;
const record = (operation) => append(${JSON.stringify(operationsPath)}, JSON.stringify(operation) + "\\n");
const lockNames = new Set([${JSON.stringify(path.basename(lockPath))}, "gateway.state.lock"]);
const guard = (target, method) => {
  const original = target[method];
  target[method] = function(file, ...args) {
    if (lockNames.has(path.basename(String(file)))) {
      record(method);
      throw new Error("Capability probe accessed the owner lock: " + method);
    }
    return original.call(this, file, ...args);
  };
};
for (const method of ["open", "stat", "lstat", "readFile", "utimes", "lutimes", "access"]) {
  guard(fs, method);
  guard(fs, method + "Sync");
  guard(fs.promises, method);
}
guard(fs, "existsSync");
threads.Worker = new Proxy(threads.Worker, {
  construct(target, args, newTarget) {
    if (String(args[0]).includes("gateway-state-owner-heartbeat")) {
      record("heartbeat worker");
      throw new Error("Capability probe started owner renewal");
    }
    return Reflect.construct(target, args, newTarget);
  }
});
require("node:module").syncBuiltinESMExports();
if (threads.isMainThread) record("ready");
`,
  );
  const childEnv = { ...env, NODE_OPTIONS: `--require ${JSON.stringify(preloadPath)}` };
  const startTime = getFileLockProcessStartTime(process.pid);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  return {
    stateDir,
    probeOperations: () =>
      fs
        .readFileSync(operationsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    // A historical Gateway owns immutable payload bytes; its fixture must not
    // renew mtime while the child probe's unchanged-state snapshot is measured.
    gateway: acquireFileLockSync(lockPath, {
      lockPath,
      payload: () => ({
        pid: process.pid,
        ...(startTime === null ? {} : { startTime }),
        createdAt: new Date().toISOString(),
        configPath,
        role: "gateway",
      }),
    }),
    run: (args: string[]) =>
      tempDirs.track(
        source
          ? runSourceRuntime(
              runtimeRoot,
              childEnv,
              [path.join(runtimeRoot, "src/entry.ts"), ...args],
              CLI_CHILD_TIMEOUT_MS,
            )
          : runBuiltRuntime(runtimeRoot, childEnv, args, CLI_CHILD_TIMEOUT_MS),
      ),
  };
}

function snapshotState(stateDir: string) {
  return listDirectoryTreeStrictSync(stateDir)
    .map((walkEntry) => walkEntry.relativePath)
    .toSorted((left, right) => left.localeCompare(right))
    .map((relative) => {
      const pathname = path.join(stateDir, relative);
      const stat = fs.statSync(pathname);
      return [
        relative,
        stat.mtimeMs,
        stat.isFile() ? fs.readFileSync(pathname).toString("hex") : null,
      ];
    });
}

it(
  "answers capability and version probes without state writes or locks while a Gateway owns an older schema",
  async () => {
    const fixture = createFixture();
    const before = snapshotState(fixture.stateDir);
    try {
      const capability = {
        updateExecutor: "root-spawner-v1",
        targetRootBinding: true,
        definitionBackup: true,
        retainedOwnerBinding: true,
        originalDefinitionBinding: true,
        originalRuntimePinBinding: true,
      };
      for (const option of [["--update-executor", "check"], ["--update-executor=check"]]) {
        const result = await fixture.run(["gateway", "install", ...option, "--json"]);
        expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(capability);
      }
      const version = await fixture.run(["--version"]);
      expect(version.code, version.stderr).toBe(0);
      expect(version.stdout).toMatch(/^OpenClaw /u);
      expect(fixture.probeOperations()).toEqual(["ready", "ready", "ready"]);
      expect(snapshotState(fixture.stateDir)).toEqual(before);
    } finally {
      fixture.gateway.release();
    }
  },
  getCliProcessTestTimeout(CLI_CHILD_TIMEOUT_MS, CLI_CHILD_TIMEOUT_MS, CLI_CHILD_TIMEOUT_MS),
);
