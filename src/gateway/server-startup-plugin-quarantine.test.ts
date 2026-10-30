/** Real Gateway readiness coverage for configured plugin payload quarantine. */
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { create as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { refreshStartupPluginQuarantine } from "../commands/doctor-config-preflight-plugin-verification.js";
import {
  readConfigFileSnapshot,
  writeConfigFile as writeUpdateFixtureConfig,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { installPluginFromPath } from "../plugins/install.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync } from "../plugins/installed-plugin-index-records.js";
import { runPluginPayloadSmokeCheck } from "../plugins/payload-verification.js";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
  type PluginCache,
} from "../plugins/plugin-cache.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  installGatewayTestHooks,
  setTestPluginRegistry,
  startTestGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const registries: PluginRegistry[] = [];
const caches: PluginCache[] = [];

function createFixturePluginCache(): PluginCache {
  const cache = createPluginCache();
  caches.push(cache);
  return cache;
}

async function disposeFixtures<T>(items: T[], dispose: (item: T) => Promise<unknown>) {
  const results = await Promise.allSettled(
    items
      .splice(0)
      .toReversed()
      .map((item) => dispose(item)),
  );
  for (const result of results) {
    expect.soft(result).toMatchObject({ status: "fulfilled", value: { failures: [] } });
  }
}

const findPlugin = (registry: PluginRegistry, id: string) =>
  registry.plugins.find((entry) => entry.id === id);

describe("Gateway startup plugin quarantine", () => {
  let cache: PluginCache;
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  const tempDirs = createTempDirTracker();
  const importChannel = channel(`openclaw.test.plugin-quarantine.${randomUUID()}`);
  const imported = new Set<unknown>();
  const observeImport = (id: unknown) => imported.add(id);

  function fixturePlugin(
    id: string,
    {
      main = "./index.cjs",
      peer = false,
      fails = false,
      payload = true,
      additionalProperties = false,
    } = {},
  ) {
    const root = tempDirs.make("openclaw-quarantine-");
    const write = (name: string, value: unknown) =>
      fs.writeFileSync(path.join(root, name), JSON.stringify(value), "utf8");
    write("package.json", {
      name: id,
      version: "1.0.0",
      type: "commonjs",
      main,
      openclaw: { extensions: ["./index.cjs"] },
      ...(peer ? { peerDependencies: { openclaw: ">=2026.1.1" } } : {}),
    });
    if (payload) {
      write("openclaw.plugin.json", {
        id,
        configSchema: { type: "object", additionalProperties, properties: {} },
      });
      fs.writeFileSync(
        path.join(root, "index.cjs"),
        fails
          ? "throw new Error('import failed');"
          : `require("node:diagnostics_channel").channel(${JSON.stringify(importChannel.name)}).publish(${JSON.stringify(id)});
module.exports = { id: '${id}', register() {} };`,
        "utf8",
      );
    }
    return root;
  }

  async function quarantine(roots: Record<string, string>) {
    const smoke = await runPluginPayloadSmokeCheck({
      records: Object.fromEntries(
        Object.entries(roots).map(([id, installPath]) => [
          id,
          { source: "npm", spec: id, installPath } satisfies PluginInstallRecord,
        ]),
      ),
      env: process.env,
    });
    setActiveDegradedPlugins(buildDegradedPluginsFromVerificationFailures(smoke.failures));
  }

  function explicitPluginConfig(roots: Record<string, string>) {
    const ids = Object.keys(roots);
    return {
      plugins: {
        enabled: true,
        load: { paths: Object.values(roots) },
        allow: ids,
        entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
      },
    };
  }

  async function loadRegistry(
    config: OpenClawConfig,
    onlyPluginIds: string[],
    previousRegistry?: PluginRegistry,
    pluginCache = cache,
  ) {
    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const registry = withPluginCache(pluginCache, () =>
      loadOpenClawPlugins({ cache: false, config, onlyPluginIds, previousRegistry }),
    );
    registries.push(registry);
    return registry;
  }

  async function startRegistry() {
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    server = await startTestGatewayServer(claim, { auth: { mode: "none" } });
    return `http://127.0.0.1:${claim.port}`;
  }

  function expectImports(brokenId: string, validId: string) {
    expect(imported.has(brokenId)).toBe(false);
    expect(imported.has(validId)).toBe(true);
  }

  beforeEach(() => {
    cache = createFixturePluginCache();
    importChannel.subscribe(observeImport);
  });

  afterEach(async () => {
    try {
      await server?.close();
    } finally {
      server = undefined;
      // Published registries own their instances independently of their discovery cache.
      await disposeFixtures(registries, disposePluginRegistryInstances);
      await disposeFixtures(caches, retirePluginCache);
      setActiveDegradedPlugins([]);
      importChannel.unsubscribe(observeImport);
      imported.clear();
      tempDirs.cleanup();
    }
  });

  it("reaches readiness with a quarantined plugin beside a valid declared extension", async () => {
    const brokenPluginId = "broken-payload";
    const validPluginId = "valid-declared-extension";
    const brokenRoot = fixturePlugin(brokenPluginId, { main: "./missing-main.cjs", peer: true });
    const validRoot = fixturePlugin(validPluginId, { main: "./missing-main.cjs" });

    const roots = { [brokenPluginId]: brokenRoot, [validPluginId]: validRoot };
    await quarantine(roots);
    const config = explicitPluginConfig(roots);
    const registry = await loadRegistry(config, [brokenPluginId, validPluginId]);
    expect(findPlugin(registry, brokenPluginId)).toMatchObject({
      status: "error",
      activated: false,
      activationReason: "configured-unavailable: missing-openclaw-peer-link",
    });
    expect(findPlugin(registry, validPluginId)).toMatchObject({
      status: "loaded",
      activated: true,
    });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: brokenPluginId,
        code: "plugin-verification",
      }),
    );
    expect(
      registry.diagnostics.find((diagnostic) => diagnostic.pluginId === brokenPluginId)?.message,
    ).not.toContain(brokenRoot);
    expectImports(brokenPluginId, validPluginId);

    setTestPluginRegistry(registry);
    await writeUpdateFixtureConfig({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      ...config,
    });

    const ready = await fetch(`${await startRegistry()}/readyz`);

    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true });
    expectImports(brokenPluginId, validPluginId);
  });

  it.each([false, true])(
    "clears quarantine only for a healthy explicit override (import fails: %s)",
    async (fails) => {
      const pluginId = fails ? "failed-shadow" : "shadowed-payload";
      const brokenRoot = fixturePlugin(pluginId, { main: "./missing-main.cjs", payload: false });
      const selectedRoot = fixturePlugin(pluginId, { fails });
      await quarantine({ [pluginId]: brokenRoot });

      const config = explicitPluginConfig({ [pluginId]: selectedRoot });
      const registry = await loadRegistry(config, [pluginId]);

      expect(findPlugin(registry, pluginId)?.status).toBe(fails ? "error" : "loaded");
      if (fails) {
        expect(listActiveDegradedPlugins()).toMatchObject([
          { pluginId, diagnostic: { installPath: brokenRoot } },
        ]);
      } else {
        expect(imported.has(pluginId)).toBe(true);
        expect(listActiveDegradedPlugins()).toEqual([]);
        const replacement = await loadRegistry(config, [pluginId], registry);
        expect(findPlugin(replacement, pluginId)).toBe(findPlugin(registry, pluginId));
      }
    },
  );
  it("keeps the core ready and authored state intact while a broken optional payload is repaired", async () => {
    const root = tempDirs.make("openclaw-plugin-degradation-");
    const pluginId = "optional-update-fixture";
    const sourceDir = fixturePlugin(pluginId, { additionalProperties: true });
    const extensionsDir = path.join(root, "extensions");
    const archivePath = path.join(root, "fixture.tgz");
    await createTar({ gzip: true, file: archivePath, cwd: sourceDir }, ["."]);
    const installed = await installPluginFromPath({ path: archivePath, extensionsDir });
    expect(installed.ok).toBe(true);
    if (!installed.ok) {
      throw new Error(installed.error);
    }
    const installPath = installed.targetDir;
    // Fault injection affects only an optional payload. Its repair source and user state survive.
    const dataPath = path.join(root, "plugin-user-data.txt");
    await fsPromises.writeFile(dataPath, "newer state must survive\n");
    const config: OpenClawConfig = {
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      plugins: {
        enabled: true,
        allow: [pluginId],
        load: { paths: [installPath] },
        entries: { [pluginId]: { enabled: true, config: { retained: "required by operator" } } },
      },
    };
    await writeUpdateFixtureConfig(config);
    const snapshot = await readConfigFileSnapshot();
    const configBytes = await fsPromises.readFile(snapshot.path, "utf8");
    const records: Record<string, PluginInstallRecord> = {
      [pluginId]: { source: "git", installPath, version: "1.0.0" },
    };
    await seedInstalledPluginIndex(records, { config, env: process.env });
    await fsPromises.unlink(path.join(installPath, "index.cjs"));
    const loadGeneration = () => {
      const generationCache = createFixturePluginCache();
      return withPluginCache(generationCache, async () => {
        const refreshed = await refreshStartupPluginQuarantine({ cfg: config, env: process.env });
        setActiveDegradedPlugins(refreshed.quarantinedPlugins);
        return loadRegistry(config, [pluginId], undefined, generationCache);
      });
    };
    const degradedRegistry = await loadGeneration();
    expect(listActiveDegradedPlugins()).toMatchObject([
      { pluginId, state: "configured-unavailable" },
    ]);
    // Missing entries can be excluded during discovery. The boot quarantine still
    // reports the unavailable configured owner, and no runtime may activate it.
    expect(
      degradedRegistry.plugins.some((plugin) => plugin.id === pluginId && plugin.activated),
    ).toBe(false);
    setTestPluginRegistry(degradedRegistry);
    const baseUrl = await startRegistry();
    const expectHealthy = async (endpoint: "healthz" | "readyz") =>
      expect((await fetch(`${baseUrl}/${endpoint}`)).status).toBe(200);
    await expectHealthy("healthz");
    await expectHealthy("readyz");

    const repaired = await installPluginFromPath({
      path: archivePath,
      extensionsDir,
      mode: "update",
      expectedPluginId: pluginId,
    });
    expect(repaired.ok).toBe(true);
    // Repair does not stop the viable core. The existing reload/startup owner clears quarantine.
    await expectHealthy("healthz");
    const repairedRegistry = await loadGeneration();
    expect(listActiveDegradedPlugins()).toEqual([]);
    expect(findPlugin(repairedRegistry, pluginId)).toMatchObject({
      status: "loaded",
      activated: true,
    });
    setTestPluginRegistry(repairedRegistry);
    await expectHealthy("readyz");
    expect(await fsPromises.readFile(snapshot.path, "utf8")).toBe(configBytes);
    expect(await fsPromises.readFile(dataPath, "utf8")).toBe("newer state must survive\n");
    expect(
      await readPersistedInstalledPluginIndexInstallRecordsAsync({ env: process.env }),
    ).toEqual(records);
  });
});
