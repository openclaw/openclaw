import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { disposePluginRegistryInstances } from "./runtime.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each(["unapproved", "reassigned", "enabled", "allowlisted", "denied", "disabled"] as const)(
  "checks %s workspace ownership before module execution",
  async (policy) => {
    useNoBundledPlugins();
    const workspaceDir = makePluginLoaderTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
    const imported = path.join(workspaceDir, "imported");
    const plugin = writePlugin({
      id: "new-owner",
      dir: path.join(workspaceDir, ".openclaw", "extensions", "new-owner"),
      filename: "index.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "loaded");
module.exports = { id: "new-owner", register() {} };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        kind: "context-engine",
        contextEngineIds: ["existing-engine"],
        configSchema: EMPTY_PLUGIN_SCHEMA,
      }),
    );
    const incidentalImported = path.join(workspaceDir, "incidental-imported");
    writePlugin({
      id: "existing-engine",
      dir: path.join(workspaceDir, ".openclaw", "extensions", "existing-engine"),
      filename: "index.cjs",
      body: `require("node:fs").writeFileSync(${JSON.stringify(incidentalImported)}, "loaded");
module.exports = { id: "existing-engine", register() {} };`,
    });
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "none", contextEngine: "existing-engine" },
        ...(["enabled", "denied", "disabled"].includes(policy)
          ? { entries: { "new-owner": { enabled: policy !== "disabled" } } }
          : {}),
        ...(policy === "denied" ? { deny: ["new-owner"] } : {}),
        ...(policy === "allowlisted" ? { allow: ["new-owner"] } : {}),
        ...(policy === "reassigned" ? { entries: { "old-owner": { enabled: true } } } : {}),
      },
    };
    const registry = loadOpenClawPlugins({ config, workspaceDir, cache: false });
    try {
      const record = registry.plugins.find((entry) => entry.id === plugin.id);
      expect(record?.origin).toBe("workspace");
      const approved = policy === "enabled" || policy === "allowlisted";
      expect(record?.status).toBe(approved ? "loaded" : "disabled");
      expect(fs.existsSync(imported)).toBe(approved);
      expect(fs.existsSync(incidentalImported)).toBe(false);
    } finally {
      await disposePluginRegistryInstances(registry);
    }
  },
);

it.each(["unapproved", "denied", "disabled", "excluded", "approved"] as const)(
  "checks eligible collision owners before module execution: %s claimant",
  async (policy) => {
    useNoBundledPlugins();
    const workspaceDir = makePluginLoaderTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
    const markers = ["approved-owner", "other-owner"].map((id) => {
      const marker = path.join(workspaceDir, `${id}-imported`);
      const plugin = writePlugin({
        id,
        dir: path.join(workspaceDir, ".openclaw", "extensions", id),
        filename: "index.cjs",
        body: `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");
module.exports = { id: ${JSON.stringify(id)}, register() {} };`,
      });
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          kind: "context-engine",
          contextEngineIds: ["shared-engine"],
          configSchema: EMPTY_PLUGIN_SCHEMA,
        }),
      );
      return marker;
    });
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "none", contextEngine: "shared-engine" },
        entries: {
          "approved-owner": { enabled: true },
          ...(policy !== "unapproved" ? { "other-owner": { enabled: policy !== "disabled" } } : {}),
        },
        ...(policy === "denied" ? { deny: ["other-owner"] } : {}),
        ...(policy === "excluded" ? { allow: ["approved-owner"] } : {}),
      },
    };
    if (policy === "approved") {
      expect(() => loadOpenClawPlugins({ config, workspaceDir, cache: false })).toThrow(
        'Context engine "shared-engine" has ambiguous declared owners: approved-owner, other-owner',
      );
      expect(markers.map((marker) => fs.existsSync(marker))).toEqual([false, false]);
      return;
    }
    const registry = loadOpenClawPlugins({ config, workspaceDir, cache: false });
    try {
      expect(registry.plugins.find((plugin) => plugin.id === "approved-owner")?.status).toBe(
        "loaded",
      );
      expect(registry.plugins.find((plugin) => plugin.id === "other-owner")?.status).toBe(
        "disabled",
      );
      expect(markers.map((marker) => fs.existsSync(marker))).toEqual([true, false]);
    } finally {
      await disposePluginRegistryInstances(registry);
    }
  },
);

it.each(["broken", "missing"] as const)(
  "selects a declared engine through cold startup and clears it with %s plugin source",
  async (sourceState) => {
    const { resolveContextEngine } = await import("../context-engine/registry.js");
    const { loadGatewayStartupPluginPlan } = await import("./gateway-startup-plugin-loader.js");
    const { planPluginUninstall } = await import("./uninstall.js");
    useNoBundledPlugins();
    const stateDir = makePluginLoaderTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const imported = path.join(stateDir, "runtime-imported");
    const plugin = writePlugin({
      id: "vendor-plugin",
      body: `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "loaded");
module.exports = { id: "vendor-plugin", kind: "context-engine", register(api) {
  api.registerContextEngine("canonical-engine", () => ({
    info: { id: "canonical-engine", name: "Synthetic Engine" },
    ingest: async () => ({ ingested: true }),
    assemble: async () => ({ messages: [], estimatedTokens: 0, systemPromptAddition: "custom-engine-used" }),
    compact: async () => ({ ok: true, compacted: false }),
  }));
} };`,
    });
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        kind: "context-engine",
        contextEngineIds: ["canonical-engine"],
        configSchema: EMPTY_PLUGIN_SCHEMA,
      }),
    );
    const config: OpenClawConfig = {
      plugins: {
        allow: [plugin.id],
        entries: { [plugin.id]: { enabled: true } },
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
      },
    };
    const metadata = loadPluginMetadataSnapshot({
      config,
      allowCurrent: false,
      preferPersisted: false,
    });
    expect(metadata.byPluginId.get(plugin.id)?.contextEngineIds).toEqual(["canonical-engine"]);
    const selected = await applySlotSelectionForPlugin(config, plugin.id, metadata);
    expect(selected.config.plugins?.slots?.contextEngine).toBe("canonical-engine");
    expect(fs.existsSync(imported)).toBe(false);

    const configPath = path.join(stateDir, "selected-config.json");
    fs.writeFileSync(configPath, JSON.stringify(selected.config));
    const persisted: OpenClawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    clearPluginMetadataLifecycleCaches();
    const fresh = loadPluginMetadataSnapshot({
      config: persisted,
      allowCurrent: false,
      preferPersisted: false,
    });
    const plan = loadGatewayStartupPluginPlan({
      config: persisted,
      env: process.env,
      metadataSnapshot: fresh,
    });
    expect(plan.pluginIds).toContain(plugin.id);
    expect(plan.pluginIds).not.toContain("canonical-engine");
    expect(fs.existsSync(imported)).toBe(false);
    const registry = loadOpenClawPlugins({
      config: persisted,
      onlyPluginIds: [...plan.pluginIds],
      runtimeSideEffects: true,
      cache: false,
    });
    try {
      expect(registry.plugins.find((entry) => entry.id === plugin.id)?.status).toBe("loaded");
      const engine = await resolveContextEngine(persisted);
      try {
        expect(engine.info.id).toBe("canonical-engine");
        expect(await engine.assemble({ sessionId: "synthetic", messages: [] })).toMatchObject({
          systemPromptAddition: "custom-engine-used",
        });
      } finally {
        await engine.dispose?.();
      }
    } finally {
      await disposePluginRegistryInstances(registry);
    }

    // The install ledger survives source failure. No runtime introspection is available here.
    persisted.plugins!.installs = {
      [plugin.id]: {
        source: "path",
        sourcePath: plugin.dir,
        contextEngineIdsByPlugin: { [plugin.id]: ["canonical-engine"] },
      },
    };
    if (sourceState === "broken") {
      fs.writeFileSync(plugin.file, "throw new Error('must not import during uninstall');");
    } else {
      fs.rmSync(plugin.dir, { recursive: true });
    }
    const uninstall = planPluginUninstall({
      config: persisted,
      pluginId: plugin.id,
      deleteFiles: false,
    });
    expect(uninstall.ok).toBe(true);
    if (!uninstall.ok) {
      throw new Error(uninstall.error);
    }
    expect(uninstall.actions.contextEngineSlot).toBe(true);
    expect(uninstall.config.plugins?.slots?.contextEngine).toBeUndefined();
  },
);
