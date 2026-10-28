import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
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
beforeEach(() => {
  useNoBundledPlugins();
  vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
});

function enginePlugin(id: string, engineId?: string, dir?: string, body?: string) {
  const plugin = writePlugin({
    id,
    dir,
    filename: "index.cjs",
    body: body ?? 'throw new Error("slot selection must not import runtime");',
  });
  if (engineId) {
    fs.writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        kind: "context-engine",
        contextEngineIds: [engineId],
        configSchema: EMPTY_PLUGIN_SCHEMA,
      }),
    );
  }
  return plugin;
}

function workspacePlugin(workspace: string, id: string, engineId?: string, registration = "") {
  const marker = path.join(workspace, `${id}-imported`);
  const plugin = enginePlugin(
    id,
    engineId,
    path.join(workspace, ".openclaw", "extensions", id),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");
module.exports = { id: ${JSON.stringify(id)}, ${registration ? 'kind: "context-engine",' : ""} register(api) { ${registration} } };`,
  );
  return { ...plugin, marker };
}

function engineRegistration(id: string, addition: string) {
  return `api.registerContextEngine(${JSON.stringify(id)}, () => ({
    info: { id: ${JSON.stringify(id)}, name: "Synthetic Engine" },
    ingest: async () => ({ ingested: true }),
    assemble: async () => ({ messages: [], estimatedTokens: 0, systemPromptAddition: ${JSON.stringify(addition)} }),
    compact: async () => ({ ok: true, compacted: false }),
  }));`;
}

function metadata(config: OpenClawConfig) {
  return loadPluginMetadataSnapshot({ config, allowCurrent: false, preferPersisted: false });
}

it.each([false, true])(
  "preserves declared ownership when repairing plugin-ID selection: %s",
  async (hasDeclaredOwner) => {
    const plugins = [
      { id: "vendor-plugin", engineId: "canonical-engine" },
      ...(hasDeclaredOwner ? [{ id: "owner-a", engineId: "vendor-plugin" }] : []),
    ].map(({ id, engineId }) => enginePlugin(id, engineId));
    const config: OpenClawConfig = {
      plugins: {
        allow: plugins.map((plugin) => plugin.id),
        load: { paths: plugins.map((plugin) => plugin.file) },
        slots: { memory: "none", contextEngine: "vendor-plugin" },
      },
    };
    const selected = await applySlotSelectionForPlugin(config, "vendor-plugin", metadata(config));
    expect(selected.plugins?.slots?.contextEngine).toBe(
      hasDeclaredOwner ? "vendor-plugin" : "canonical-engine",
    );
  },
);

it("repairs a mixed-case legacy plugin-ID slot before runtime import", async () => {
  const plugin = enginePlugin("MiXeD-demo", "canonical-engine");
  const config: OpenClawConfig = {
    plugins: {
      allow: ["mixed-demo"],
      load: { paths: [plugin.file] },
      slots: { memory: "none", contextEngine: "MiXeD-demo" },
    },
  };
  const selected = await applySlotSelectionForPlugin(config, plugin.id, metadata(config));
  expect(selected.plugins?.slots?.contextEngine).toBe("canonical-engine");
});

it.each(["unapproved", "reassigned", "enabled", "allowlisted", "denied", "disabled"] as const)(
  "checks %s workspace ownership before module execution",
  async (policy) => {
    const workspaceDir = makePluginLoaderTempDir();
    const plugin = workspacePlugin(workspaceDir, "new-owner", "existing-engine");
    const incidental = workspacePlugin(workspaceDir, "existing-engine");
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
      expect(fs.existsSync(plugin.marker)).toBe(approved);
      expect(fs.existsSync(incidental.marker)).toBe(false);
    } finally {
      await disposePluginRegistryInstances(registry);
    }
  },
);

it.each(["unapproved", "denied", "disabled", "excluded", "approved"] as const)(
  "checks eligible collision owners before module execution: %s claimant",
  async (policy) => {
    const workspaceDir = makePluginLoaderTempDir();
    const markers = ["approved-owner", "other-owner"].map(
      (id) => workspacePlugin(workspaceDir, id, "shared-engine").marker,
    );
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

it.each(["unapproved", "denied", "disabled", "excluded"] as const)(
  "preserves an approved undeclared equal-ID engine against a %s claimant",
  async (policy) => {
    const { resolveContextEngine } = await import("../context-engine/registry.js");
    const workspaceDir = makePluginLoaderTempDir();
    const owner = workspacePlugin(
      workspaceDir,
      "existing-engine",
      undefined,
      engineRegistration("existing-engine", "existing-engine-used"),
    );
    const claimant = workspacePlugin(workspaceDir, "new-owner", "existing-engine");
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "none", contextEngine: "existing-engine" },
        ...(policy === "disabled" ? { allow: ["new-owner"] } : {}),
        ...(policy === "excluded" ? { allow: ["unrelated"] } : {}),
        entries: {
          "existing-engine": { enabled: true },
          ...(policy !== "unapproved" ? { "new-owner": { enabled: policy !== "disabled" } } : {}),
        },
        ...(policy === "denied" ? { deny: ["new-owner"] } : {}),
      },
    };
    const registry = loadOpenClawPlugins({
      config,
      workspaceDir,
      cache: false,
      runtimeSideEffects: true,
    });
    try {
      expect(registry.plugins.find((plugin) => plugin.id === "existing-engine")?.status).toBe(
        "loaded",
      );
      expect(fs.existsSync(owner.marker)).toBe(true);
      expect(registry.plugins.find((plugin) => plugin.id === "new-owner")?.status).toBe("disabled");
      expect(fs.existsSync(claimant.marker)).toBe(false);
      const engine = await resolveContextEngine(config);
      try {
        expect(await engine.assemble({ sessionId: "synthetic", messages: [] })).toMatchObject({
          systemPromptAddition: "existing-engine-used",
        });
      } finally {
        await engine.dispose?.();
      }
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
    const stateDir = makePluginLoaderTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const imported = path.join(stateDir, "runtime-imported");
    const plugin = enginePlugin(
      "vendor-plugin",
      "canonical-engine",
      undefined,
      `require("node:fs").writeFileSync(${JSON.stringify(imported)}, "loaded");
module.exports = { id: "vendor-plugin", kind: "context-engine", register(api) {
  ${engineRegistration("canonical-engine", "custom-engine-used")}
} };`,
    );
    const config: OpenClawConfig = {
      plugins: {
        allow: [plugin.id],
        entries: { [plugin.id]: { enabled: true } },
        load: { paths: [plugin.file] },
        slots: { memory: "none" },
      },
    };
    const snapshot = metadata(config);
    expect(snapshot.byPluginId.get(plugin.id)?.contextEngineIds).toEqual(["canonical-engine"]);
    const selected = await applySlotSelectionForPlugin(config, plugin.id, snapshot);
    expect(selected.plugins?.slots?.contextEngine).toBe("canonical-engine");
    expect(fs.existsSync(imported)).toBe(false);

    const configPath = path.join(stateDir, "selected-config.json");
    fs.writeFileSync(configPath, JSON.stringify(selected));
    const persisted: OpenClawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    clearPluginMetadataLifecycleCaches();
    const fresh = metadata(persisted);
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
