// Ownership decisions must survive registry replacement and unrelated capability admission.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
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

afterEach(async () => {
  await resetContextEngineRuntimeQuarantineForTests();
  resetPluginLoaderTestStateForTest();
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

let workspaceDir: string;
beforeEach(() => {
  useNoBundledPlugins();
  workspaceDir = makePluginLoaderTempDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
});

function load(config: OpenClawConfig, previousRegistry?: ReturnType<typeof loadOpenClawPlugins>) {
  return loadOpenClawPlugins({
    config,
    workspaceDir,
    cache: false,
    runtimeSideEffects: true,
    previousRegistry,
  });
}

function configuration(
  plugins: Array<{ file: string }>,
  engineId: string,
  policy: NonNullable<OpenClawConfig["plugins"]> = {},
): OpenClawConfig {
  return {
    plugins: {
      load: { paths: plugins.map(({ file }) => file) },
      slots: { memory: "none", contextEngine: engineId },
      ...policy,
    },
  };
}

// Generated entries exercise the production loader without importing bundled plugin runtimes.
function writeEnginePlugin(
  id: string,
  engineIds: string[],
  kind?: "memory" | "context-engine",
  declaredEngineIds = kind === "context-engine" ? engineIds : undefined,
) {
  const plugin = writePlugin({
    id,
    dir: path.join(workspaceDir, id),
    filename: "index.cjs",
    body: `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  fs.appendFileSync(${JSON.stringify(path.join(workspaceDir, "registrations"))}, ${JSON.stringify(id + "\n")});
  api.registerService({ id: ${JSON.stringify(id + "-service")}, start() {} });
  for (const engineId of ${JSON.stringify(engineIds)}) {
    api.registerContextEngine(engineId, () => {
      fs.appendFileSync(${JSON.stringify(path.join(workspaceDir, "factories"))}, ${JSON.stringify(id + ":")} + engineId + "\\n");
      return {
        info: { id: engineId, name: "Synthetic Engine" },
        ingest: async () => ({ ingested: true }),
        assemble: async () => ({ messages: [], estimatedTokens: 0, systemPromptAddition: ${JSON.stringify(id)} }),
        compact: async () => ({ ok: true, compacted: false }),
      };
    });
  }
} };`,
  });
  fs.writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      kind,
      contextEngineIds: declaredEngineIds,
      configSchema: EMPTY_PLUGIN_SCHEMA,
    }),
  );
  return plugin;
}

it.each([
  { engineId: "canonical-engine", allow: ["mixed-demo"] },
  { engineId: "MiXeD-demo", allow: ["unrelated"] },
])("loads mixed-case owner of exact engine $engineId", async ({ engineId, allow }) => {
  const plugin = writeEnginePlugin("MiXeD-demo", [engineId], "context-engine");
  const config = configuration([plugin], engineId, { allow });
  const registry = load(config);
  try {
    expect(getPluginRuntimeLoadContextState(registry)?.selectedContextEngine).toEqual({
      engineId,
      owner: "plugin:MiXeD-demo",
    });
    const record = registry.plugins.find((entry) => entry.id === "MiXeD-demo");
    expect(record?.error).toBeUndefined();
    expect(record?.status).toBe("loaded");
    expect(registry.contextEngines.get(engineId)?.owner).toBe("plugin:MiXeD-demo");
    const { resolveContextEngine } = await import("../context-engine/registry.js");
    await ensureContextEnginesInitialized();
    const engine = await resolveContextEngine(config);
    try {
      expect(engine.info.id).toBe(engineId);
      expect(await engine.assemble({ sessionId: "synthetic", messages: [] })).toMatchObject({
        systemPromptAddition: "MiXeD-demo",
      });
    } finally {
      await engine.dispose?.();
    }
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});

it("keeps canonical denial ahead of mixed-case equal-ID selection", async () => {
  const plugin = writeEnginePlugin("MiXeD-demo", ["MiXeD-demo"], "context-engine");
  const registry = load(configuration([plugin], "MiXeD-demo", { deny: ["mixed-demo"] }));
  try {
    expect(registry.plugins.find((record) => record.id === "MiXeD-demo")?.status).toBe("disabled");
    expect(getPluginRuntimeLoadContextState(registry)?.selectedContextEngine).toEqual({
      engineId: "MiXeD-demo",
      owner: null,
    });
    expect(registry.contextEngines.has("MiXeD-demo")).toBe(false);
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});

it("rebuilds declared factories when switching engines on the same owner", async () => {
  const { resolveContextEngine, resolveLogicalTurnContextEngines } =
    await import("../context-engine/registry.js");
  const plugins = [
    writeEnginePlugin("secondary-capability", ["second"]),
    writeEnginePlugin("vendor", ["first", "second"], "context-engine"),
    writeEnginePlugin("ordinary", []),
  ];
  const config = configuration(plugins, "first", {
    entries: {
      "secondary-capability": { enabled: true },
      vendor: { enabled: true },
      ordinary: { enabled: true },
    },
  });
  const initial = load(config);
  let replacement: ReturnType<typeof loadOpenClawPlugins> | undefined;
  try {
    expect(fs.readFileSync(path.join(workspaceDir, "registrations"), "utf8")).toBe(
      "secondary-capability\nvendor\nordinary\n",
    );
    expect(initial.contextEngines.get("first")?.owner).toBe("plugin:vendor");
    expect(initial.contextEngines.get("second")?.owner).toBe("plugin:secondary-capability");
    expect(getPluginRuntimeLoadContextState(initial)?.selectedContextEngine).toEqual({
      engineId: "first",
      owner: "plugin:vendor",
    });
    const nextConfig: OpenClawConfig = {
      ...config,
      plugins: { ...config.plugins, slots: { memory: "none", contextEngine: "second" } },
    };
    replacement = load(nextConfig, initial);
    expect(getPluginRuntimeLoadContextState(replacement)?.selectedContextEngine).toEqual({
      engineId: "second",
      owner: "plugin:vendor",
    });
    expect(replacement.contextEngines.get("second")?.owner).toBe("plugin:vendor");
    expect(replacement.plugins.find((plugin) => plugin.id === "vendor")).not.toBe(
      initial.plugins.find((plugin) => plugin.id === "vendor"),
    );
    expect(replacement.plugins.find((plugin) => plugin.id === "secondary-capability")).not.toBe(
      initial.plugins.find((plugin) => plugin.id === "secondary-capability"),
    );
    expect(replacement.services.map((entry) => entry.service.id).toSorted()).toEqual([
      "ordinary-service",
      "secondary-capability-service",
      "vendor-service",
    ]);

    // An unchanged follow-up generation may retain the ordinary plugin and selected factory.
    const unchanged = load(nextConfig, replacement);
    try {
      await ensureContextEnginesInitialized();
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
        for (const turnEngine of new Set([turn.configured.engine, turn.fallback.engine])) {
          await disposeContextEngineSources(
            turnEngine,
            turn.sourceResources?.get(turnEngine) ?? [],
          );
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
    const plugins = [
      writeEnginePlugin("existing-engine", ["existing-engine"], "memory"),
      writeEnginePlugin("claimant", ["existing-engine"], "context-engine"),
    ];
    // A restrictive allowlist leaves neither plugin approved; the memory slot still admits its owner.
    const config = configuration(plugins, "existing-engine", {
      allow: ["unrelated-plugin"],
      slots: { memory: "existing-engine", contextEngine: "existing-engine" },
    });
    const registry = load(config);
    try {
      await ensureContextEnginesInitialized();
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
