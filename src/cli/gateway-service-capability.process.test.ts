import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  createBuiltRuntime,
  createSourceRuntime,
  runBuiltRuntime,
  runSourceRuntime,
} from "../commands/doctor-config-preflight.process.test-support.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  acquireGatewayLifecycleCoordinator,
  acquireStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
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
  return {
    databasePath,
    stateDir,
    run: (args: string[]) =>
      source
        ? tempDirs.track(
            runSourceRuntime(
              runtimeRoot,
              env,
              [path.join(runtimeRoot, "src/entry.ts"), ...args],
              CLI_CHILD_TIMEOUT_MS,
            ),
          )
        : tempDirs.track(runBuiltRuntime(runtimeRoot, env, args, CLI_CHILD_TIMEOUT_MS)),
  };
}

function snapshotState(stateDir: string) {
  return fs
    .readdirSync(stateDir, { recursive: true })
    .toSorted((left, right) => String(left).localeCompare(String(right)))
    .map((relative) => {
      const pathname = path.join(stateDir, String(relative));
      const stat = fs.statSync(pathname);
      return [
        relative,
        stat.mtimeMs,
        stat.isFile() ? fs.readFileSync(pathname).toString("hex") : null,
      ];
    });
}

describe("candidate service capability startup", () => {
  it(
    "answers capability and version probes without state writes or locks while a Gateway owns an older schema",
    async () => {
      const fixture = createFixture();
      const gateway = acquireGatewayLifecycleCoordinator({ databasePath: fixture.databasePath });
      const before = snapshotState(fixture.stateDir);
      try {
        const result = await fixture.run([
          "gateway",
          "install",
          "--update-executor",
          "check",
          "--json",
        ]);
        expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
          updateExecutor: "root-spawner-v1",
          targetRootBinding: true,
          definitionBackup: true,
        });
        const state = acquireStateDatabaseCoordinator({ databasePath: fixture.databasePath });
        try {
          const locked = await fixture.run([
            "gateway",
            "install",
            "--update-executor=check",
            "--json",
          ]);
          expect(locked.code, locked.stderr).toBe(0);
          expect(JSON.parse(locked.stdout)).toEqual(JSON.parse(result.stdout));
        } finally {
          state.release();
        }
        const version = await fixture.run(["--version"]);
        expect(version.code, version.stderr).toBe(0);
        expect(version.stdout).toMatch(/^OpenClaw /u);
        expect(snapshotState(fixture.stateDir)).toEqual(before);
        const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
        try {
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
            OPENCLAW_STATE_SCHEMA_VERSION - 1,
          );
        } finally {
          database.close();
        }
      } finally {
        gateway.release();
      }
    },
    getCliProcessTestTimeout(CLI_CHILD_TIMEOUT_MS, CLI_CHILD_TIMEOUT_MS, CLI_CHILD_TIMEOUT_MS),
  );

  it("keeps ordinary service commands behind the live Gateway schema fence", async () => {
    const fixture = createFixture();
    const gateway = acquireGatewayLifecycleCoordinator({ databasePath: fixture.databasePath });
    const before = fs.readFileSync(fixture.databasePath);
    try {
      const result = await fixture.run(["gateway", "install", "--json"]);
      expect(result.code).toBe(1);
      expect(`${result.stderr}\n${result.stdout}`).toContain(
        "because another Gateway owns that state directory",
      );
      expect(fs.readFileSync(fixture.databasePath)).toEqual(before);
    } finally {
      gateway.release();
    }
  });
});
