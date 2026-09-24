// Ownership decisions must survive registry replacement and unrelated capability admission.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureContextEnginesInitialized } from "../context-engine/init.js";
import { disposeContextEngineSources } from "../context-engine/registry.resources.js";
import { resetContextEngineRuntimeQuarantineForTests } from "../context-engine/registry.test-support.js";
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
import { disposePluginRegistryInstances } from "./runtime.js";
import { getPluginRuntimeLoadContextState } from "./runtime/load-context-state.js";

afterEach(() => {
  resetContextEngineRuntimeQuarantineForTests();
  resetPluginLoaderTestStateForTest();
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

// Generated entries exercise the production loader without importing bundled plugin runtimes.
function writeEnginePlugin(params: {
  workspaceDir: string;
  id: string;
  engineIds: string[];
  kind?: "memory" | "context-engine";
  declaredEngineIds?: string[];
}) {
  const plugin = writePlugin({
    id: params.id,
    dir: path.join(params.workspaceDir, params.id),
    filename: "index.cjs",
    body: `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(params.id)}, register(api) {
  fs.appendFileSync(${JSON.stringify(path.join(params.workspaceDir, "registrations"))}, ${JSON.stringify(params.id + "\n")});
  api.registerService({ id: ${JSON.stringify(params.id + "-service")}, start() {} });
  for (const engineId of ${JSON.stringify(params.engineIds)}) {
    api.registerContextEngine(engineId, () => {
      fs.appendFileSync(${JSON.stringify(path.join(params.workspaceDir, "factories"))}, ${JSON.stringify(params.id + ":")} + engineId + "\\n");
      return {
        info: { id: engineId, name: "Synthetic Engine" },
        ingest: async () => ({ ingested: true }),
        assemble: async () => ({ messages: [], estimatedTokens: 0, systemPromptAddition: ${JSON.stringify(params.id)} }),
        compact: async () => ({ ok: true, compacted: false }),
      };
    });
  }
} };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      kind: params.kind,
      contextEngineIds: params.declaredEngineIds,
      configSchema: EMPTY_PLUGIN_SCHEMA,
    }),
  );
  return plugin;
}

it("rebuilds declared factories when switching engines on the same owner", async () => {
  const { resolveContextEngine, resolveLogicalTurnContextEngines } =
    await import("../context-engine/registry.js");
  useNoBundledPlugins();
  const workspaceDir = makePluginLoaderTempDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
  const plugins = [
    writeEnginePlugin({ workspaceDir, id: "second", engineIds: ["second"] }),
    writeEnginePlugin({
      workspaceDir,
      id: "vendor",
      engineIds: ["first", "second"],
      kind: "context-engine",
      declaredEngineIds: ["first", "second"],
    }),
    writeEnginePlugin({ workspaceDir, id: "ordinary", engineIds: [] }),
  ];
  const config: OpenClawConfig = {
    plugins: {
      load: { paths: plugins.map((plugin) => plugin.file) },
      entries: {
        second: { enabled: true },
        vendor: { enabled: true },
        ordinary: { enabled: true },
      },
      slots: { memory: "none", contextEngine: "first" },
    },
  };
  const initial = loadOpenClawPlugins({
    config,
    workspaceDir,
    cache: false,
    runtimeSideEffects: true,
  });
  let replacement: ReturnType<typeof loadOpenClawPlugins> | undefined;
  try {
    expect(fs.readFileSync(path.join(workspaceDir, "registrations"), "utf8")).toBe(
      "second\nvendor\nordinary\n",
    );
    expect(initial.contextEngines.get("first")?.owner).toBe("plugin:vendor");
    expect(initial.contextEngines.get("second")?.owner).toBe("plugin:second");
    expect(getPluginRuntimeLoadContextState(initial)?.selectedContextEngine).toEqual({
      engineId: "first",
      owner: "plugin:vendor",
    });
    const nextConfig: OpenClawConfig = {
      ...config,
      plugins: { ...config.plugins, slots: { memory: "none", contextEngine: "second" } },
    };
    replacement = loadOpenClawPlugins({
      config: nextConfig,
      workspaceDir,
      cache: false,
      runtimeSideEffects: true,
      previousRegistry: initial,
    });
    expect(getPluginRuntimeLoadContextState(replacement)?.selectedContextEngine).toEqual({
      engineId: "second",
      owner: "plugin:vendor",
    });
    expect(replacement.contextEngines.get("second")?.owner).toBe("plugin:vendor");
    expect(replacement.plugins.find((plugin) => plugin.id === "vendor")).not.toBe(
      initial.plugins.find((plugin) => plugin.id === "vendor"),
    );
    expect(replacement.plugins.find((plugin) => plugin.id === "second")).not.toBe(
      initial.plugins.find((plugin) => plugin.id === "second"),
    );
    expect(replacement.services.map((entry) => entry.service.id).toSorted()).toEqual([
      "ordinary-service",
      "second-service",
      "vendor-service",
    ]);

    // An unchanged follow-up generation may retain the ordinary plugin and selected factory.
    const unchanged = loadOpenClawPlugins({
      config: nextConfig,
      workspaceDir,
      cache: false,
      runtimeSideEffects: true,
      previousRegistry: replacement,
    });
    try {
      ensureContextEnginesInitialized();
      expect(unchanged.plugins.find((plugin) => plugin.id === "ordinary")).toBe(
        replacement.plugins.find((plugin) => plugin.id === "ordinary"),
      );
      expect(unchanged.contextEngines.get("second")?.factory).toBe(
        replacement.contextEngines.get("second")?.factory,
      );
      const engine = await resolveContextEngine(nextConfig);
      try {
        expect(await engine.assemble({ sessionId: "synthetic", messages: [] })).toMatchObject({
          systemPromptAddition: "vendor",
        });
      } finally {
        await engine.dispose?.();
      }
      const turn = await resolveLogicalTurnContextEngines(nextConfig);
      try {
        expect(turn.configuredId).toBe("second");
        expect(turn.configured.ownerPluginId).toBe("vendor");
        expect(turn.configuredFailure).toBeUndefined();
        expect(
          await turn.configured.engine.assemble({ sessionId: "synthetic", messages: [] }),
        ).toMatchObject({ systemPromptAddition: "vendor" });
      } finally {
        for (const engine of new Set([turn.configured.engine, turn.fallback.engine])) {
          await disposeContextEngineSources(engine, turn.sourceResources?.get(engine) ?? []);
        }
      }
      expect(fs.readFileSync(path.join(workspaceDir, "factories"), "utf8")).toBe(
        "vendor:second\nvendor:second\n",
      );
    } finally {
      await disposePluginRegistryInstances(unchanged);
    }
  } finally {
    if (replacement) {
      await disposePluginRegistryInstances(replacement);
    }
    await disposePluginRegistryInstances(initial);
  }
});

it.each(["standalone", "logical-turn"] as const)(
  "keeps an unapproved engine inactive despite memory-slot admission via %s",
  async (resolver) => {
    const { resolveContextEngine, resolveLogicalTurnContextEngines } =
      await import("../context-engine/registry.js");
    useNoBundledPlugins();
    const workspaceDir = makePluginLoaderTempDir();
    vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
    const plugins = [
      writeEnginePlugin({
        workspaceDir,
        id: "existing-engine",
        engineIds: ["existing-engine"],
        kind: "memory",
      }),
      writeEnginePlugin({
        workspaceDir,
        id: "claimant",
        engineIds: ["existing-engine"],
        kind: "context-engine",
        declaredEngineIds: ["existing-engine"],
      }),
    ];
    // Neither plugin has independent approval; only the memory slot admits ordinary capability.
    const config: OpenClawConfig = {
      plugins: {
        load: { paths: plugins.map((plugin) => plugin.file) },
        slots: { memory: "existing-engine", contextEngine: "existing-engine" },
      },
    };
    const registry = loadOpenClawPlugins({
      config,
      workspaceDir,
      cache: false,
      runtimeSideEffects: true,
    });
    try {
      ensureContextEnginesInitialized();
      expect(fs.readFileSync(path.join(workspaceDir, "registrations"), "utf8")).toBe(
        "existing-engine\n",
      );
      expect(getPluginRuntimeLoadContextState(registry)?.selectedContextEngine).toEqual({
        engineId: "existing-engine",
        owner: null,
      });
      expect(registry.plugins.find((plugin) => plugin.id === "existing-engine")?.status).toBe(
        "loaded",
      );
      expect(registry.services.map((entry) => entry.service.id)).toEqual([
        "existing-engine-service",
      ]);
      expect(registry.contextEngines.has("existing-engine")).toBe(false);
      if (resolver === "standalone") {
        const engine = await resolveContextEngine(config);
        try {
          expect(engine.info.id).toBe("legacy");
        } finally {
          await engine.dispose?.();
        }
      } else {
        const turn = await resolveLogicalTurnContextEngines(config);
        try {
          expect(turn.configuredId).toBe("legacy");
          expect(turn.configured).toBe(turn.fallback);
          expect(turn.configured.ownerPluginId).toBeUndefined();
          expect(turn.configuredFailure).toBeUndefined();
        } finally {
          for (const engine of new Set([turn.configured.engine, turn.fallback.engine])) {
            await disposeContextEngineSources(engine, turn.sourceResources?.get(engine) ?? []);
          }
        }
      }
      expect(fs.existsSync(path.join(workspaceDir, "factories"))).toBe(false);
      expect(config.plugins?.slots?.contextEngine).toBe("existing-engine");
    } finally {
      await disposePluginRegistryInstances(registry);
    }
  },
);
