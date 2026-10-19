import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveDefaultAgentWorkspaceDir } from "../../src/agents/workspace-default.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { hasActiveStartupMigrationLease } from "../../src/infra/startup-migration-checkpoint.js";
import { writePersistedInstalledPluginIndex } from "../../src/plugins/installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "../../src/plugins/installed-plugin-index-store.js";
import { clearPluginMetadataLifecycleCaches } from "../../src/plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";
import { writeManagedNpmPlugin } from "../../src/plugins/test-helpers/managed-npm-plugin.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../helpers/openclaw-test-instance.js";

const instances: OpenClawTestInstance[] = [];
async function createInstance(name: string, env: NodeJS.ProcessEnv) {
  const instance = await createOpenClawTestInstance({
    name,
    env: { OPENCLAW_TEST_FAST: "1", ...env },
    startTimeoutMs: 90_000,
  });
  instances.push(instance);
  return instance;
}
function clearState() {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
}

afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.cleanup()));
  clearState();
});

it("keeps an empty legacy state dir separate when the canonical root exists", async () => {
  const instance = await createInstance("doctor-empty-legacy-state-dir", {
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_HOME: undefined,
    OPENCLAW_STATE_DIR: undefined,
  });
  const legacyDir = path.join(instance.homeDir, ".clawdbot");
  fs.mkdirSync(legacyDir, { recursive: true });
  const expectLegacyDir = (output: string, separate = true) => {
    expect(fs.lstatSync(legacyDir).isDirectory(), output).toBe(true);
    expect(fs.readdirSync(legacyDir)).toEqual([]);
    if (separate) {
      expect(fs.realpathSync(legacyDir), output).not.toBe(fs.realpathSync(instance.stateDir));
    }
  };

  await instance.startGateway();

  expectLegacyDir(instance.logs(), false);

  await instance.stopGateway();
  const repaired = await instance.cli(["doctor", "--repair", "--yes", "--non-interactive"]);
  expect(repaired, repaired.stderr).toMatchObject({ code: 0, signal: null });
  expectLegacyDir(repaired.stdout);
  await instance.startGateway();
  expectLegacyDir(instance.logs());
}, 120_000);

it("starts with current metadata and refreshes the stale persisted index after readiness", async ({
  signal,
}) => {
  const instance = await createInstance("doctor-plugin-index-persistence", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
  });

  const config = JSON.parse(fs.readFileSync(instance.configPath, "utf8")) as OpenClawConfig;
  const pluginId = "legacy-doctor-index";
  const pluginDir = writeManagedNpmPlugin({
    stateDir: instance.stateDir,
    packageName: "@openclaw/legacy-doctor-index",
    pluginId,
    version: "1.0.0",
  });
  const packageJsonPath = path.join(pluginDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    openclaw: Record<string, unknown>;
  };
  packageJson.openclaw.build = {
    bundledDist: false,
    openclawVersion: "2026.7.2",
    pluginSdkVersion: "2026.7.2",
  };
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson), "utf8");
  fs.writeFileSync(
    path.join(pluginDir, "doctor-contract-api.cjs"),
    "module.exports = { stateMigrations: [] };\n",
    "utf8",
  );

  const current = loadPluginMetadataSnapshot({
    config,
    env: instance.env,
    stateDir: instance.stateDir,
    workspaceDir: resolveDefaultAgentWorkspaceDir(instance.env),
  });
  const legacyIndex = {
    ...current.index,
    plugins: current.index.plugins.map(
      ({ doctorContractFile: _file, doctorContractHash: _hash, ...plugin }) => plugin,
    ),
  };
  await writePersistedInstalledPluginIndex(legacyIndex, { env: instance.env });
  clearState();

  expect(await instance.entrypoint()).toEqual([
    expect.stringMatching(/^dist\/index\.(?:js|mjs)$/u),
  ]);
  await instance.startGateway();
  expect(hasActiveStartupMigrationLease({ env: instance.env }), instance.logs()).toBe(false);

  const child = instance.child;
  if (!child) {
    throw new Error("Gateway process is unavailable after readiness");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      child.stdout.off("data", check);
      child.stderr.off("data", check);
      child.off("close", closed);
      signal.removeEventListener("abort", aborted);
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () =>
      fail(new Error(`Gateway stopped before registry maintenance settled\n${instance.logs()}`));
    const aborted = () => fail(new Error("Registry maintenance aborted", { cause: signal.reason }));
    const check = () => {
      if (
        /startup (?:phase|trace): startup\.maintenance\.plugin-registry [\d.]+ms total=/u.test(
          instance.logs(),
        )
      ) {
        cleanup();
        resolve();
      } else if (child.exitCode !== null || child.signalCode !== null) {
        closed();
      } else if (signal.aborted) {
        aborted();
      }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    check();
  });

  clearState();
  const persisted = readPersistedInstalledPluginIndexSync({ env: instance.env });
  const persistedPlugin = persisted?.plugins.find((plugin) => plugin.pluginId === pluginId);
  expect(persistedPlugin, instance.logs()).toMatchObject({
    doctorContractFile: {
      ctimeMs: expect.any(Number),
      mtimeMs: expect.any(Number),
      size: expect.any(Number),
    },
    doctorContractHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    packageBuild: { bundledDist: false },
  });

  // Source readers intentionally select different bundled Doctor contracts.
  // Observe the repaired index through the same built host as the Gateway.
  const listed = await instance.cli(["plugins", "list", "--json"]);
  expect(listed, listed.stderr).toMatchObject({ code: 0, signal: null });
  const reread = JSON.parse(listed.stdout) as {
    registry: { source: string; diagnostics: unknown[] };
  };
  expect(reread.registry, instance.logs()).toMatchObject({
    source: "persisted",
    diagnostics: [],
  });

  clearState();
  expect(readPersistedInstalledPluginIndexSync({ env: instance.env })).toEqual(persisted);
}, 120_000);
