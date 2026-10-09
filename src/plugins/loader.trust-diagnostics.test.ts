import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { maybeRepairPluginRegistryState } from "../commands/doctor-plugin-registry.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { buildPluginInspectReport, buildPluginSnapshotReport } from "./status.js";

const defaultPluginId = "diagnostics-otel";
const defaultPackageName = `@openclaw/${defaultPluginId}`;
const agentMailIntegrity = normalizeClawHubSha256Integrity(
  "sha256:155221cec38673a39bc27629f9f6ec87567ce4e37b7fa619ec4b1f7ca3d28730",
);
if (!agentMailIntegrity) {
  throw new Error("Expected a valid AgentMail catalog integrity");
}

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  resetPluginLoaderTestStateForTest();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("recorded plugin trust diagnostics", () => {
  it("warns once across registry reloads and again for changed provenance or a restarted Gateway", async () => {
    useNoBundledPlugins();
    const first = writePlugin({ id: "unverified-reload", filename: "index.cjs", registration: "" });
    const replacement = writePlugin({ id: first.id, filename: "index.cjs", registration: "" });
    const other = writePlugin({ id: "unverified-other", registration: "" });
    for (const plugin of [first, replacement]) {
      writePluginMetadata({
        dir: plugin.dir,
        id: plugin.id,
        packageJson: {
          name: `@vendor/${plugin.id}`,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        },
      });
    }
    const warn = vi.fn();
    const load = (plugin = first, activate = true, install?: PluginInstallRecord) => {
      const registry = loadOpenClawPlugins({
        config: {
          plugins: {
            load: { paths: [plugin.file] },
            entries: { [plugin.id]: { enabled: true } },
            slots: { memory: "none" },
          },
        },
        installRecords: install ? { [plugin.id]: install } : {},
        cache: false,
        activate,
        logger: { info() {}, warn, error() {}, debug() {} },
      });
      expect(registry.plugins.find(({ id }) => id === plugin.id)?.status).toBe("loaded");
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "warn",
          pluginId: plugin.id,
          message: expect.stringContaining(`openclaw plugins inspect ${plugin.id}`),
        }),
      );
    };
    load(first, false);
    expect(warn).not.toHaveBeenCalled();
    load();
    for (let reload = 0; reload < 4; reload++) {
      clearPluginRegistryLoadCache();
      load();
    }
    await using cache = createPluginCache();
    withPluginCache(cache, () => load());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(first.file);
    load(replacement);
    load(replacement);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toContain(replacement.file);
    const install: PluginInstallRecord = {
      source: "npm",
      spec: "@vendor/unverified-reload@1.0.0",
      installPath: replacement.dir,
      resolvedName: "@vendor/different-package",
    };
    load(replacement, true, install);
    load(replacement, true, install);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2]?.[0]).toContain("provenance-invalid");
    const resolvedSpec = "@vendor/unverified-reload@2.0.0";
    load(replacement, true, { ...install, resolvedSpec });
    load(replacement, true, { resolvedSpec, ...install });
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[3]?.[0]).toBe(warn.mock.calls[2]?.[0]);
    load(other);
    expect(warn).toHaveBeenCalledTimes(5);
    await drainGlobalSingletonLifecycleState("restart");
    load(other);
    expect(warn).toHaveBeenCalledTimes(6);
  });

  it.each([
    { name: "legacy npm spec", override: {}, reason: "trusted-official", trusted: true },
    {
      name: "official install through a symlinked state root",
      symlinkedStateRoot: true,
      reason: "trusted-official",
      trusted: true,
    },
    {
      name: "legacy ClawHub spec",
      override: { source: "clawhub", spec: `clawhub:${defaultPackageName}@2026.8.2` },
      reason: "provenance-missing",
      trusted: false,
      repair: true,
    },
    { name: "missing record", missing: true, reason: "record-missing", trusted: false },
    { name: "path install", override: { source: "path" }, reason: "origin-path", trusted: false },
    {
      name: "missing provenance",
      override: { spec: undefined },
      reason: "provenance-missing",
      trusted: false,
    },
    {
      name: "conflicting identity",
      override: { resolvedName: "@vendor/diffs" },
      reason: "provenance-invalid",
      trusted: false,
    },
    {
      name: "local npm archive",
      override: { artifactKind: "npm-pack" },
      reason: "origin-path",
      trusted: false,
    },
    {
      name: "official AgentMail ClawHub install",
      pluginId: "agentmail",
      packageName: "@agentmail/agentmail",
      version: "0.2.1",
      override: {
        source: "clawhub",
        spec: "clawhub:@agentmail/agentmail@0.2.1",
        clawhubPackage: "@agentmail/agentmail",
        clawhubUrl: "https://clawhub.ai",
        clawhubChannel: "official",
      },
      reason: "trusted-official",
      trusted: true,
    },
    {
      name: "legacy AgentMail ClawHub install",
      pluginId: "agentmail",
      packageName: "@agentmail/agentmail",
      version: "0.2.1",
      override: { source: "clawhub", spec: "clawhub:@agentmail/agentmail@0.2.1" },
      reason: "provenance-missing",
      trusted: false,
      repair: true,
      repairTrusted: false,
    },
    {
      name: "legacy AgentMail ClawHub install with matching integrity",
      pluginId: "agentmail",
      packageName: "@agentmail/agentmail",
      version: "0.2.1",
      override: {
        source: "clawhub",
        spec: "clawhub:@agentmail/agentmail@0.2.1",
        integrity: agentMailIntegrity,
      },
      reason: "provenance-missing",
      trusted: false,
      repair: true,
      repairTrusted: true,
    },
    {
      name: "unendorsed AgentMail npm namesake",
      pluginId: "agentmail",
      packageName: "@agentmail/agentmail",
      version: "0.2.1",
      reason: "provenance-invalid",
      trusted: false,
    },
  ] satisfies Array<{
    name: string;
    pluginId?: string;
    packageName?: string;
    version?: string;
    override?: Partial<PluginInstallRecord>;
    missing?: boolean;
    symlinkedStateRoot?: boolean;
    reason: string;
    trusted: boolean;
    repair?: boolean;
    repairTrusted?: boolean;
  }>)(
    "inspection and registration agree for $name",
    async ({
      override,
      missing,
      symlinkedStateRoot,
      reason,
      trusted,
      repair,
      repairTrusted,
      pluginId = defaultPluginId,
      packageName = defaultPackageName,
      version = "2026.8.2",
    }) => {
      useNoBundledPlugins();
      const stateDir = fs.realpathSync(makePluginLoaderTempDir());
      const plugin = writePlugin({
        id: pluginId,
        dir: path.join(stateDir, "extensions", pluginId),
        filename: "index.cjs",
        body: `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
          api.runtime.state.openKeyedStore({ namespace: "proof", maxEntries: 2 });
          api.runtime.state.openChannelIngressQueue({ accountId: "default" });
        } };`,
      });
      writePluginMetadata({
        dir: plugin.dir,
        id: plugin.id,
        packageJson: {
          name: packageName,
          version,
          openclaw: { extensions: ["./index.cjs"] },
        },
      });
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        let installPath = plugin.dir;
        if (symlinkedStateRoot) {
          const linkedStateDir = path.join(makePluginLoaderTempDir(), "linked-state");
          fs.symlinkSync(
            stateDir,
            linkedStateDir,
            process.platform === "win32" ? "junction" : "dir",
          );
          installPath = path.join(linkedStateDir, "extensions", pluginId);
        }
        const install: PluginInstallRecord = {
          source: "npm",
          spec: `${packageName}@${version}`,
          installPath,
          ...override,
        };
        await refreshPersistedInstalledPluginIndex({
          reason: "source-changed",
          installRecords: missing ? {} : { [pluginId]: install },
        });
        const config = {
          plugins: {
            allow: [plugin.id],
            entries: { [plugin.id]: { enabled: true } },
            slots: { memory: "none" },
          },
        };
        const snapshot = buildPluginSnapshotReport({ config });
        const inspected = buildPluginInspectReport({
          id: plugin.id,
          config,
          report: snapshot,
        })!.plugin;
        const warn = vi.fn();
        const registry = loadOpenClawPlugins({
          config,
          cache: false,
          logger: { info() {}, warn, error() {}, debug() {} },
        });
        const loaded = registry.plugins.find((entry) => entry.id === plugin.id)!;
        expect(inspected.trustedOfficialInstall === true).toBe(trusted);
        expect(loaded.trustedOfficialInstall === true).toBe(trusted);
        expect(inspected.trust).toEqual(loaded.trust);
        expect(loaded.trust).toMatchObject({
          reason,
          registryPath: path.join(stateDir, "state", "openclaw.sqlite"),
          origin: "global",
        });
        expect(loaded.status).toBe("loaded");
        const warnings = warn.mock.calls.filter(([message]) =>
          String(message).includes("OpenClaw can't verify where this plugin came from"),
        );
        if (
          reason === "record-missing" ||
          reason === "provenance-missing" ||
          reason === "provenance-invalid"
        ) {
          expect(warnings).toHaveLength(1);
          expect(warnings[0]![0]).toContain(`reason=${reason}`);
          expect(warnings[0]![0]).toContain(`openclaw plugins inspect ${plugin.id}`);
          expect(registry.diagnostics).toContainEqual(
            expect.objectContaining({
              level: "warn",
              pluginId: plugin.id,
              message: expect.stringContaining(`reason=${reason}`),
            }),
          );
        } else {
          expect(warnings).toHaveLength(0);
        }
        if (repair) {
          await maybeRepairPluginRegistryState({
            config,
            stateDir,
            prompter: { shouldRepair: true },
          });
          const repaired = loadOpenClawPlugins({ config, cache: false }).plugins.find(
            (entry) => entry.id === pluginId,
          )!;
          const inspectedAfter = buildPluginSnapshotReport({ config }).plugins.find(
            (entry) => entry.id === pluginId,
          )!;
          expect(repaired).toMatchObject({
            status: "loaded",
            trust: { reason: repairTrusted === false ? reason : "trusted-official" },
          });
          expect(repaired.trustedOfficialInstall === true).toBe(repairTrusted !== false);
          expect(inspectedAfter.trust).toEqual(repaired.trust);
        }
      });
    },
  );

  it("loads local state and ingress without granting hook agent turns", async () => {
    useNoBundledPlugins();
    const stateDir = fs.realpathSync(makePluginLoaderTempDir());
    const plugins = ["local-one", "local-two"].map((id) =>
      writePlugin({
        id,
        registration: `
          const store = api.runtime.state.openKeyedStore({ namespace: "shared-name", maxEntries: 2 });
          const queue = api.runtime.state.openChannelIngressQueue({ accountId: "default" });
          api.registerTool({
            name: api.id, description: "Local state fixture", parameters: { type: "object" },
            async execute(_callId, params) {
              if (params.hook) {
                return await api.runtime.hooks.dispatchHookAgentTurn({
                  name: "Local watcher", agentId: "main", sessionKey: "hook:local:1",
                  message: "Local event", externalContentSource: "email", deliver: false,
                });
              }
              const before = { value: await store.lookup("key"), pending: await queue.listPending() };
              await store.register("key", api.id);
              await queue.enqueue("event", { plugin: api.id });
              const delivered = [];
              const drain = api.runtime.state.openChannelIngressDrain({
                accountId: "default",
                dispatchClaimedEvent(event) { delivered.push(event.payload.plugin); },
              });
              try {
                await drain.drainOnce();
                await drain.waitForIdle();
                return { content: [], details: { before, value: await store.lookup("key"), delivered } };
              } finally { drain.dispose(); }
            },
          });`,
      }),
    );
    for (const plugin of plugins) {
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id: plugin.id,
          configSchema: { type: "object" },
          contracts: { tools: [plugin.id] },
        }),
      );
    }
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const dispatchHookAgentTurn = vi.fn(async () => ({
        ok: true as const,
        runId: "unexpected-hook-run",
      }));
      const registry = loadOpenClawPlugins({
        config: {
          plugins: {
            allow: plugins.map(({ id }) => id),
            load: { paths: plugins.map(({ file }) => file) },
            slots: { memory: "none" },
          },
        },
        cache: false,
        runtimeOptions: { hooks: { dispatchHookAgentTurn } },
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      try {
        expect(registry.diagnostics.filter(({ level }) => level === "error")).toEqual([]);
        for (const { id } of plugins) {
          const loaded = registry.plugins.find((plugin) => plugin.id === id)!;
          expect(loaded).toMatchObject({
            status: "loaded",
            origin: "config",
          });
          expect(loaded.trustedOfficialInstall).not.toBe(true);
          const tool = registry.tools.find((entry) => entry.pluginId === id)?.factory({});
          if (!tool || Array.isArray(tool)) {
            throw new Error(`Expected ${id} fixture tool`);
          }
          await expect(tool.execute("state", {})).resolves.toMatchObject({
            details: { before: { value: undefined, pending: [] }, value: id, delivered: [id] },
          });
          await expect(tool.execute("hook", { hook: true })).rejects.toMatchObject({
            code: "PLUGIN_TRUST_REFUSED",
            message: expect.stringContaining(
              "dispatchHookAgentTurn is only available for trusted plugins",
            ),
          });
        }
        expect(dispatchHookAgentTurn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        await disposePluginRegistryInstances(registry);
        await closeOpenClawStateDatabaseAsync();
      }
    });
  });
});
