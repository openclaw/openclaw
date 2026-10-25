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

const registries: ReturnType<typeof loadOpenClawPlugins>[] = [];
afterEach(async () => {
  try {
    await registries
      .splice(0)
      .reduceRight(
        (done, registry) => done.finally(() => disposePluginRegistryInstances(registry)),
        Promise.resolve(),
      );
  } finally {
    await resetContextEngineRuntimeQuarantineForTests();
    resetPluginLoaderTestStateForTest();
    clearPluginMetadataLifecycleCaches();
    vi.unstubAllEnvs();
  }
});
afterAll(cleanupPluginLoaderFixturesForTest);

let workspaceDir: string;
beforeEach(() => {
  useNoBundledPlugins();
  workspaceDir = makePluginLoaderTempDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
});

function load(config: OpenClawConfig, previousRegistry?: ReturnType<typeof loadOpenClawPlugins>) {
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir,
    cache: false,
    runtimeSideEffects: true,
    previousRegistry,
  });
  registries.push(registry);
  return registry;
}

async function expectEngine(config: OpenClawConfig, id: string, addition?: string) {
  const { resolveContextEngine } = await import("../context-engine/registry.js");
  await ensureContextEnginesInitialized();
  const engine = await resolveContextEngine(config);
  try {
    expect(engine.info.id).toBe(id);
    if (addition) {
      expect(await engine.assemble({ sessionId: "synthetic", messages: [] })).toMatchObject({
        systemPromptAddition: addition,
      });
    }
  } finally {
    await engine.dispose?.();
  }
}

async function expectTurn(config: OpenClawConfig, id: string, owner?: string) {
  const { resolveLogicalTurnContextEngines } = await import("../context-engine/registry.js");
  const turn = await resolveLogicalTurnContextEngines(config);
  try {
    expect(turn.configuredId).toBe(id);
    expect(turn.configured.ownerPluginId).toBe(owner);
    expect(turn.configuredFailure).toBeUndefined();
    if (owner) {
      expect(
        await turn.configured.engine.assemble({ sessionId: "synthetic", messages: [] }),
      ).toMatchObject({ systemPromptAddition: owner });
    } else {
      expect(turn.configured).toBe(turn.fallback);
    }
  } finally {
    for (const engine of new Set([turn.configured.engine, turn.fallback.engine])) {
      await disposeContextEngineSources(engine, turn.sourceResources?.get(engine) ?? []);
    }
  }
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
  expect(getPluginRuntimeLoadContextState(registry)?.selectedContextEngine).toEqual({
    engineId,
    owner: "plugin:MiXeD-demo",
  });
  expect(registry.contextEngines.get(engineId)?.owner).toBe("plugin:MiXeD-demo");
  await expectEngine(config, engineId, "MiXeD-demo");
});

it("keeps canonical denial ahead of mixed-case equal-ID selection", async () => {
  const plugin = writeEnginePlugin("MiXeD-demo", ["MiXeD-demo"], "context-engine");
  const registry = load(configuration([plugin], "MiXeD-demo", { deny: ["mixed-demo"] }));
  expect(registry.plugins.find((record) => record.id === "MiXeD-demo")?.status).toBe("disabled");
  expect(getPluginRuntimeLoadContextState(registry)?.selectedContextEngine).toEqual({
    engineId: "MiXeD-demo",
    owner: null,
  });
  expect(registry.contextEngines.has("MiXeD-demo")).toBe(false);
});

it("rebuilds declared factories when switching engines on the same owner", async () => {
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
  const replacement = load(nextConfig, initial);
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
  expect(unchanged.plugins.find((plugin) => plugin.id === "ordinary")).toBe(
    replacement.plugins.find((plugin) => plugin.id === "ordinary"),
  );
  expect(unchanged.contextEngines.get("second")?.factory).toBe(
    replacement.contextEngines.get("second")?.factory,
  );
  await expectEngine(nextConfig, "second", "vendor");
  await expectTurn(nextConfig, "second", "vendor");
  expect(fs.readFileSync(path.join(workspaceDir, "factories"), "utf8")).toBe(
    "vendor:second\nvendor:second\n",
  );
});

it.each(["standalone", "logical-turn"] as const)(
  "keeps an unapproved engine inactive despite memory-slot admission via %s",
  async (resolver) => {
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
    expect(registry.services.map((entry) => entry.service.id)).toEqual(["existing-engine-service"]);
    expect(registry.contextEngines.has("existing-engine")).toBe(false);
    if (resolver === "standalone") {
      await expectEngine(config, "legacy");
    } else {
      await expectTurn(config, "legacy");
    }
    expect(fs.existsSync(path.join(workspaceDir, "factories"))).toBe(false);
    expect(config.plugins?.slots?.contextEngine).toBe("existing-engine");
  },
);
