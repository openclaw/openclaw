import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { maybeRepairPluginRegistryState } from "../commands/doctor-plugin-registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { refreshPersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { pluginConfig, writeJson } from "./loader-suite.test-support.js";
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

type TrustOptions = {
  agentMail?: boolean;
  override?: Partial<PluginInstallRecord>;
  symlinkedStateRoot?: boolean;
  repairedTrust?: boolean;
};
const agentMail = { agentMail: true };
const agentMailClawHub = {
  source: "clawhub",
  spec: "clawhub:@agentmail/agentmail@0.2.1",
} satisfies Partial<PluginInstallRecord>;
function trustCase(
  name: string,
  reason: string,
  options: TrustOptions = {},
): [string, string, TrustOptions] {
  return [name, reason, options];
}

function packagedPlugin(
  definition: Parameters<typeof writePlugin>[0],
  name = "@vendor/unverified-reload",
  version = "1.0.0",
) {
  const plugin = writePlugin({ filename: "index.cjs", ...definition });
  writePluginMetadata({
    dir: plugin.dir,
    id: plugin.id,
    packageJson: { name, version, openclaw: { extensions: ["./index.cjs"] } },
  });
  return plugin;
}

afterEach(async () => {
  try {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    resetPluginLoaderTestStateForTest();
  } finally {
    clearRuntimeConfigSnapshot();
  }
});
afterAll(cleanupPluginLoaderFixturesForTest);
beforeEach(useNoBundledPlugins);

it("warns once across registry reloads and again for changed provenance or a restarted Gateway", async () => {
  const first = packagedPlugin({ id: "unverified-reload", registration: "" });
  const replacement = packagedPlugin({ id: first.id, registration: "" });
  const other = writePlugin({ id: "unverified-other", registration: "" });
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
  trustCase("official symlinked root", "trusted-official", { symlinkedStateRoot: true }),
  trustCase("legacy ClawHub", "provenance-missing", {
    override: { source: "clawhub", spec: `clawhub:${defaultPackageName}@2026.8.2` },
    repairedTrust: true,
  }),
  trustCase("missing provenance", "provenance-missing", { override: { spec: undefined } }),
  trustCase("conflicting identity", "provenance-invalid", {
    override: { resolvedName: "@vendor/diffs" },
  }),
  trustCase("local archive", "origin-path", { override: { artifactKind: "npm-pack" } }),
  trustCase("official AgentMail", "trusted-official", {
    ...agentMail,
    override: {
      ...agentMailClawHub,
      clawhubPackage: "@agentmail/agentmail",
      clawhubUrl: "https://clawhub.ai",
      clawhubChannel: "official",
    },
  }),
  trustCase("legacy AgentMail", "provenance-missing", {
    ...agentMail,
    override: agentMailClawHub,
    repairedTrust: false,
  }),
  trustCase("legacy AgentMail with integrity", "provenance-missing", {
    ...agentMail,
    override: { ...agentMailClawHub, integrity: agentMailIntegrity },
    repairedTrust: true,
  }),
  trustCase("AgentMail npm namesake", "provenance-invalid", agentMail),
])("inspection and registration agree for %s", async (_name, reason, options = {}) => {
  const pluginId = options.agentMail ? "agentmail" : defaultPluginId;
  const packageName = options.agentMail ? "@agentmail/agentmail" : defaultPackageName;
  const version = options.agentMail ? "0.2.1" : "2026.8.2";
  const trusted = reason === "trusted-official";
  const stateDir = fs.realpathSync(makePluginLoaderTempDir());
  const plugin = packagedPlugin(
    {
      id: pluginId,
      dir: path.join(stateDir, "extensions", pluginId),
      registration: `
          api.runtime.state.openKeyedStore({ namespace: "proof", maxEntries: 2 });
          api.runtime.state.openChannelIngressQueue({ accountId: "default" });
        `,
    },
    packageName,
    version,
  );
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    let installPath = plugin.dir;
    if (options.symlinkedStateRoot) {
      const linkedStateDir = path.join(makePluginLoaderTempDir(), "linked-state");
      fs.symlinkSync(stateDir, linkedStateDir, process.platform === "win32" ? "junction" : "dir");
      installPath = path.join(linkedStateDir, "extensions", pluginId);
    }
    const install: PluginInstallRecord = {
      source: "npm",
      spec: `${packageName}@${version}`,
      installPath,
      ...options.override,
    };
    await refreshPersistedInstalledPluginIndex({
      reason: "source-changed",
      installRecords: { [pluginId]: install },
    });
    const config = {
      plugins: {
        allow: [plugin.id],
        entries: { [plugin.id]: { enabled: true } },
        slots: { memory: "none" },
      },
    };
    setRuntimeConfigSnapshot(config);
    const inspect = () =>
      buildPluginInspectReport({
        id: plugin.id,
        config,
        report: buildPluginSnapshotReport({ config }),
      })!.plugin;
    const inspected = inspect();
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
    expect(loaded).toMatchObject({
      status: "loaded",
      trust: {
        reason,
        registryPath: path.join(stateDir, "state", "openclaw.sqlite"),
        origin: "global",
      },
    });
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes("OpenClaw can't verify where this plugin came from"),
    );
    const warns = ["record-missing", "provenance-missing", "provenance-invalid"].includes(reason);
    expect(warnings).toHaveLength(warns ? 1 : 0);
    if (warns) {
      expect(warnings[0]![0]).toContain(`reason=${reason}`);
      expect(warnings[0]![0]).toContain(`openclaw plugins inspect ${plugin.id}`);
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "warn",
          pluginId: plugin.id,
          message: expect.stringContaining(`reason=${reason}`),
        }),
      );
    }
    if (options.repairedTrust !== undefined) {
      await maybeRepairPluginRegistryState({
        config,
        stateDir,
        prompter: { shouldRepair: true },
      });
      const repaired = loadOpenClawPlugins({ config, cache: false }).plugins.find(
        (entry) => entry.id === pluginId,
      )!;
      expect(repaired).toMatchObject({
        status: "loaded",
        trust: { reason: options.repairedTrust ? "trusted-official" : reason },
      });
      expect(repaired.trustedOfficialInstall === true).toBe(options.repairedTrust);
      expect(inspect().trust).toEqual(repaired.trust);
    }
  });
});

it("loads local state and ingress without granting hook agent turns", async () => {
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
    writeJson(path.join(plugin.dir, "openclaw.plugin.json"), {
      id: plugin.id,
      configSchema: { type: "object" },
      contracts: { tools: [plugin.id] },
    });
  }
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const dispatchHookAgentTurn = vi.fn(async () => ({
      ok: true as const,
      runId: "unexpected-hook-run",
    }));
    const registry = loadOpenClawPlugins({
      config: pluginConfig(...plugins),
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
