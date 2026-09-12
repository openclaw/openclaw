/** Real Gateway readiness coverage for configured plugin payload quarantine. */
import { randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { create as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { preparePostCorePluginConfig } from "../cli/update-cli/update-command-config.js";
import { updatePluginsAfterCoreUpdate } from "../cli/update-cli/update-command-plugins.js";
import { applyPostPluginConfigValidation } from "../cli/update-cli/update-command-post-plugin-validation.js";
import { refreshStartupPluginQuarantine } from "../commands/doctor-config-preflight-plugin-verification.js";
import {
  readConfigFileSnapshot,
  writeConfigFile as writeUpdateFixtureConfig,
} from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { installPluginFromPath } from "../plugins/install.js";
import {
  readPersistedInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../plugins/installed-plugin-index-records.js";
import { runPluginPayloadSmokeCheck } from "../plugins/payload-verification.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  setTestPluginRegistry,
  startTestGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("Gateway startup plugin quarantine", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  const tempDirs: string[] = [];
  const importChannel = channel(`openclaw.test.plugin-quarantine.${randomUUID()}`);
  const imported = new Set<unknown>();
  const observeImport = (id: unknown) => imported.add(id);

  beforeEach(() => importChannel.subscribe(observeImport));

  afterEach(async () => {
    await server?.close();
    server = undefined;
    setActiveDegradedPlugins([]);
    importChannel.unsubscribe(observeImport);
    imported.clear();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaches readiness with a quarantined plugin beside a valid declared extension", async () => {
    const brokenPluginId = "broken-payload";
    const validPluginId = "valid-declared-extension";
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-quarantined-plugin-"));
    const validRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-valid-stale-main-"));
    tempDirs.push(brokenRoot, validRoot);
    fs.writeFileSync(
      path.join(brokenRoot, "package.json"),
      JSON.stringify({
        name: brokenPluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
        peerDependencies: { openclaw: ">=2026.1.1" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(brokenRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: brokenPluginId,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(brokenRoot, "index.cjs"),
      `require("node:diagnostics_channel").channel(${JSON.stringify(importChannel.name)}).publish(${JSON.stringify(brokenPluginId)});
module.exports = { id: '${brokenPluginId}', register() {} };`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(validRoot, "package.json"),
      JSON.stringify({
        name: validPluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(validRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: validPluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(validRoot, "index.cjs"),
      `require("node:diagnostics_channel").channel(${JSON.stringify(importChannel.name)}).publish(${JSON.stringify(validPluginId)});
module.exports = { id: '${validPluginId}', register() {} };`,
      "utf8",
    );

    const smoke = await runPluginPayloadSmokeCheck({
      records: {
        [brokenPluginId]: {
          source: "npm",
          spec: brokenPluginId,
          installPath: brokenRoot,
        },
        [validPluginId]: { source: "npm", spec: validPluginId, installPath: validRoot },
      },
      env: process.env,
    });
    expect(smoke.checked).toEqual([brokenPluginId, validPluginId]);
    expect(smoke.failures).toMatchObject([
      {
        pluginId: brokenPluginId,
        reason: "missing-openclaw-peer-link",
        installPath: brokenRoot,
      },
    ]);
    setActiveDegradedPlugins(buildDegradedPluginsFromVerificationFailures(smoke.failures));

    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const pluginConfig = {
      enabled: true,
      load: { paths: [brokenRoot, validRoot] },
      allow: [brokenPluginId, validPluginId],
      entries: {
        [brokenPluginId]: { enabled: true },
        [validPluginId]: { enabled: true },
      },
    };
    const registry = loadOpenClawPlugins({
      cache: false,
      config: { plugins: pluginConfig },
      onlyPluginIds: [brokenPluginId, validPluginId],
    });
    expect(registry.plugins.find((plugin) => plugin.id === brokenPluginId)).toMatchObject({
      status: "error",
      activated: false,
      failurePhase: "validation",
      activationReason: "configured-unavailable: missing-openclaw-peer-link",
    });
    expect(registry.plugins.find((plugin) => plugin.id === validPluginId)).toMatchObject({
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
    expect(imported.has(brokenPluginId)).toBe(false);
    expect(imported.has(validPluginId)).toBe(true);

    setTestPluginRegistry(registry);
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      plugins: pluginConfig,
    });

    const port = await getGatewayTestPort();
    server = await startTestGatewayServer(port, { auth: { mode: "none" } });
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true });
    expect(imported.has(brokenPluginId)).toBe(false);
    expect(imported.has(validPluginId)).toBe(true);
  });

  it("does not quarantine a healthy explicit root that shadows a broken install with the same id", async () => {
    const pluginId = "shadowed-payload";
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-broken-install-"));
    const selectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-selected-plugin-"));
    tempDirs.push(brokenRoot, selectedRoot);
    fs.writeFileSync(
      path.join(brokenRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "index.cjs"),
      `require("node:diagnostics_channel").channel(${JSON.stringify(importChannel.name)}).publish(${JSON.stringify(pluginId)});
module.exports = { id: '${pluginId}', register() {} };`,
      "utf8",
    );

    const smoke = await runPluginPayloadSmokeCheck({
      records: {
        [pluginId]: { source: "npm", spec: pluginId, installPath: brokenRoot },
      },
      env: process.env,
    });
    setActiveDegradedPlugins(buildDegradedPluginsFromVerificationFailures(smoke.failures));

    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const options = {
      cache: false,
      config: {
        plugins: {
          enabled: true,
          load: { paths: [selectedRoot] },
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
        },
      },
      onlyPluginIds: [pluginId],
    };
    const registry = loadOpenClawPlugins(options);

    expect(registry.plugins.find((plugin) => plugin.id === pluginId)?.status).toBe("loaded");
    expect(imported.has(pluginId)).toBe(true);
    expect(listActiveDegradedPlugins()).toEqual([]);
    const replacement = loadOpenClawPlugins({ ...options, previousRegistry: registry });
    expect(replacement.plugins.find((plugin) => plugin.id === pluginId)).toBe(
      registry.plugins.find((plugin) => plugin.id === pluginId),
    );
  });

  it("keeps the broken install visible when its explicit override fails to load", async () => {
    const pluginId = "failed-shadow";
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-broken-install-"));
    const selectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-selected-plugin-"));
    tempDirs.push(brokenRoot, selectedRoot);
    fs.writeFileSync(
      path.join(brokenRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "index.cjs"),
      "throw new Error('import failed');",
      "utf8",
    );

    const smoke = await runPluginPayloadSmokeCheck({
      records: {
        [pluginId]: { source: "npm", spec: pluginId, installPath: brokenRoot },
      },
      env: process.env,
    });
    setActiveDegradedPlugins(buildDegradedPluginsFromVerificationFailures(smoke.failures));

    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
          load: { paths: [selectedRoot] },
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
        },
      },
      onlyPluginIds: [pluginId],
    });

    expect(registry.plugins.find((plugin) => plugin.id === pluginId)?.status).toBe("error");
    expect(listActiveDegradedPlugins()).toMatchObject([
      { pluginId, diagnostic: { installPath: brokenRoot } },
    ]);
  });
});

describe("updater plugin degradation with a running source Gateway", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
    setActiveDegradedPlugins([]);
  });

  it("keeps the core ready and authored state intact while a broken optional payload is repaired", async () => {
    const root = tempDirs.make("openclaw-plugin-degradation-");
    const pluginId = "optional-update-fixture";
    const sourceDir = path.join(root, "source");
    const extensionsDir = path.join(root, "extensions");
    await fsPromises.mkdir(sourceDir);
    await fsPromises.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: pluginId,
        version: "1.0.0",
        type: "commonjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    await fsPromises.writeFile(
      path.join(sourceDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: true },
      }),
    );
    await fsPromises.writeFile(
      path.join(sourceDir, "index.cjs"),
      `module.exports = { id: '${pluginId}', register() {} };\n`,
    );
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
    const config = {
      gateway: {
        mode: "local" as const,
        bind: "loopback" as const,
        auth: { mode: "none" as const },
      },
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
    await writePersistedInstalledPluginIndexInstallRecords(records, { config, env: process.env });
    await fsPromises.unlink(path.join(installPath, "index.cjs"));
    const update = () =>
      withPluginCache(createPluginCache(), async () =>
        updatePluginsAfterCoreUpdate({
          root,
          channel: "stable",
          ...(await preparePostCorePluginConfig({ requestedChannel: null })),
          pluginInstallRecords: records,
          pluginRequirements: { [pluginId]: "optional" },
          timeoutMs: 5_000,
          json: true,
        }),
      );
    const result = await update();
    expect(result.status).toBe("warning");
    expect(result.reason).toBeUndefined();
    expect(result.assessment).toMatchObject({
      kind: "optional-repair-needed",
      failures: [
        expect.objectContaining({ pluginId, installPath, reason: "missing-extension-entry" }),
      ],
    });
    expect(result.npm.outcomes).toContainEqual(
      expect.objectContaining({ pluginId, status: "error" }),
    );

    expect(applyPostPluginConfigValidation(result, false)).toMatchObject({
      status: "error",
      reason: "post-plugin-doctor-invalid-config",
    });
    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const loadGeneration = () =>
      withPluginCache(createPluginCache(), async () => {
        const quarantine = await refreshStartupPluginQuarantine({ cfg: config, env: process.env });
        expect(quarantine.blockingDiagnostic).toBeNull();
        setActiveDegradedPlugins(quarantine.quarantinedPlugins);
        return loadOpenClawPlugins({ cache: false, config, onlyPluginIds: [pluginId] });
      });
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
    const port = await getGatewayTestPort();
    server = await startTestGatewayServer(port, { auth: { mode: "none" } });
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);

    const repaired = await installPluginFromPath({
      path: archivePath,
      extensionsDir,
      mode: "update",
      expectedPluginId: pluginId,
    });
    expect(repaired.ok).toBe(true);
    // Repair does not stop the viable core. The existing reload/startup owner clears quarantine.
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const repairedResult = await update();
    expect(repairedResult.status).toBe("ok");
    expect(repairedResult.reason).toBeUndefined();
    expect(repairedResult.assessment).toEqual({ kind: "no-payload-repair" });
    const repairedRegistry = await loadGeneration();
    expect(listActiveDegradedPlugins()).toEqual([]);
    expect(repairedRegistry.plugins.find((plugin) => plugin.id === pluginId)).toMatchObject({
      status: "loaded",
      activated: true,
    });
    setTestPluginRegistry(repairedRegistry);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    expect(await fsPromises.readFile(snapshot.path, "utf8")).toBe(configBytes);
    expect(await fsPromises.readFile(dataPath, "utf8")).toBe("newer state must survive\n");
    expect(readPersistedInstalledPluginIndexInstallRecords({ env: process.env })).toEqual(records);
  });
});
