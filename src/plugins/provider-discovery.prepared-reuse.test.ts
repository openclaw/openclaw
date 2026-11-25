import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as catalogContext from "../agents/models-config.providers.catalog-context.js";
import * as discoveryAuth from "../agents/models-config.providers.discovery-auth.runtime.js";
import {
  prepareImplicitProviderStaticCatalog,
  resolveImplicitProviders,
} from "../agents/models-config.providers.implicit.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as modelCatalog from "../model-catalog/index.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { getPluginMetadataSnapshotCache, retirePluginCache } from "./plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import * as providerCatalog from "./provider-catalog.js";
import type { PreparedProviderStaticCatalog } from "./provider-discovery.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { getPluginRuntimeLoadContextState } from "./runtime/load-context-state.js";
import { pluginRuntimeLoaderLogger, setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import type { ProviderPlugin } from "./types.js";

async function fixture(runtimeAuth = true, authOnly?: "collision" | "sibling") {
  const state = await createOpenClawTestState({ label: "prepared-descriptor-reuse" });
  const staticId = "descriptor-static";
  const liveId = "descriptor-live";
  const authId = authOnly === "collision" ? staticId : "descriptor-auth";
  const providerIds = [staticId, liveId, ...(authOnly === "sibling" ? [authId] : [])];
  const config: OpenClawConfig = { plugins: { allow: providerIds } };
  const providerConfig = {
    api: "openai-completions" as const,
    baseUrl: "https://catalog.example.invalid/v1",
    models: [{ ...buildCatalogModel("static-model"), input: ["text" as const] }],
  };
  const authCalls = state.path("entry-auth-calls.txt");
  const discovery = state.path("provider-discovery.cjs");
  fs.writeFileSync(
    discovery,
    `module.exports = {
    id: ${JSON.stringify(liveId)}, label: "Entry fixture", auth: [],
    catalog: { run() { throw Error("superseded entry catalog executed"); } },
    resolveSyntheticAuth({ providerConfig }) {
      if (!providerConfig) return undefined;
      require("node:fs").appendFileSync(${JSON.stringify(authCalls)}, "entry\\n");
      return { apiKey: "oauth:entry", source: "entry", mode: "api-key" };
    }
  };`,
  );
  const authDiscovery = state.path("auth-discovery.cjs");
  if (authOnly) {
    fs.writeFileSync(
      authDiscovery,
      `module.exports = {
      id: ${JSON.stringify(authId)}, label: "Auth-only fixture",
      auth: [{ id: "oauth", label: "OAuth", kind: "oauth", run: async () => ({ profiles: [] }) }],
      resolveSyntheticAuth: () => ({ apiKey: "oauth:auth-only", source: "auth-only", mode: "api-key" })
    };`,
    );
  }
  const metadataInput: NonNullable<Parameters<typeof createPluginMetadataSnapshotFixture>[0]> = {
    plugins: [
      {
        id: staticId,
        providers: [staticId],
        ...(authOnly === "collision"
          ? { rootDir: path.dirname(authDiscovery), providerDiscoverySource: authDiscovery }
          : {}),
        modelCatalog: {
          discovery: { [staticId]: "static" },
          providers: { [staticId]: providerConfig },
        },
      },
      {
        id: liveId,
        rootDir: path.dirname(discovery),
        providerDiscoverySource: discovery,
        providers: [liveId],
        modelCatalog: { discovery: { [liveId]: "runtime" } },
      },
    ],
  };
  if (authOnly === "sibling") {
    metadataInput.plugins.push({
      id: authId,
      providers: [authId],
      rootDir: path.dirname(authDiscovery),
      providerDiscoverySource: authDiscovery,
    });
  }
  const metadataSnapshot = createPluginMetadataSnapshotFixture(metadataInput);
  let liveReads = 0;
  const run = vi.fn<NonNullable<ProviderPlugin["catalog"]>["run"]>(async (context) => ({
    provider: {
      ...providerConfig,
      models: [
        buildCatalogModel(`live-${++liveReads}-${context.resolveProviderApiKey(liveId).apiKey}`),
      ],
    },
  }));
  const resolveRuntimeAuth = vi.fn(() => ({
    apiKey: "oauth:runtime",
    source: "runtime",
    mode: "api-key" as const,
  }));
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({
    pluginId: liveId,
    source: "descriptor-fixture.js",
    provider: {
      id: liveId,
      label: "Live fixture",
      auth: [],
      catalog: { run },
      ...(runtimeAuth ? { resolveSyntheticAuth: resolveRuntimeAuth } : {}),
    },
  });
  const params = {
    config,
    env: state.env,
    pluginMetadataSnapshot: metadataSnapshot,
    providerDiscoveryProviderIds: providerIds,
  };
  const bind = (
    registry = pluginRegistry,
    inputs: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv } = {},
  ) =>
    setPluginRuntimeLoadContext(registry, {
      rawConfig: inputs.config ?? config,
      config: inputs.config ?? config,
      activationSourceConfig: inputs.config ?? config,
      autoEnabledReasons: {},
      env: inputs.env ?? state.env,
      workspaceDir: undefined,
      metadataSnapshot,
      manifestRegistry: metadataSnapshot.manifestRegistry,
      logger: pluginRuntimeLoaderLogger,
    });
  bind();
  return {
    ...params,
    params,
    staticId,
    liveId,
    authId,
    run,
    resolveRuntimeAuth,
    entryAuthCalls: () => (fs.existsSync(authCalls) ? fs.readFileSync(authCalls, "utf8") : ""),
    bind,
    pluginRegistry,
    scope: <T>(read: () => T, registry = pluginRegistry) =>
      withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry: registry }, read),
    read: (
      preparedStaticProviderCatalog: PreparedProviderStaticCatalog,
      changes: Partial<Parameters<typeof resolveImplicitProviders>[0]> = {},
    ) =>
      resolveImplicitProviders({
        ...params,
        agentDir: state.agentDir(),
        authStore: { version: 1, profiles: {} },
        // Only the catalog-specific config enables synthetic auth, so this observes
        // the composed descriptor callback instead of the general entry-auth lookup.
        explicitProviders: { [liveId]: { ...providerConfig, models: [] } },
        preparedStaticProviderCatalog,
        ...changes,
      }),
    async [Symbol.asyncDispose]() {
      await retirePluginCache(getPluginMetadataSnapshotCache(metadataSnapshot));
      await state.cleanup();
    },
  };
}

it.each([false, true])(
  "builds descriptors once but runs every live catalog with its composed auth (runtime auth: %s)",
  async (runtimeAuth) => {
    await using f = await fixture(runtimeAuth);
    using plans = vi.spyOn(modelCatalog, "planEffectiveModelCatalogRows");
    using configs = vi.spyOn(providerCatalog, "buildEffectiveManifestProviderConfig");
    await f.scope(async () => {
      const prepared = await prepareImplicitProviderStaticCatalog(f.params);
      for (let read = 1; read <= 3; read++) {
        const providers = await f.read(prepared);
        expect(providers?.[f.staticId]?.models.map(({ id }) => id)).toEqual(["static-model"]);
        expect(providers?.[f.liveId]?.models.map(({ id }) => id)).toEqual([
          `live-${read}-oauth:${runtimeAuth ? "runtime" : "entry"}`,
        ]);
      }
    });
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(f.resolveRuntimeAuth).toHaveBeenCalledTimes(runtimeAuth ? 3 : 0);
    expect(f.entryAuthCalls()).toBe(runtimeAuth ? "" : "entry\n".repeat(3));
    expect({ plans: plans.mock.calls.length, configs: configs.mock.calls.length }).toEqual({
      plans: 1,
      configs: 1,
    });
  },
);

it("discovers missing owners, filters narrowed scopes, and keeps unscoped discovery open", async () => {
  await using f = await fixture();
  using plans = vi.spyOn(modelCatalog, "planEffectiveModelCatalogRows");
  await f.scope(async () => {
    const prepared = await prepareImplicitProviderStaticCatalog({
      ...f.params,
      providerDiscoveryProviderIds: [f.staticId],
    });
    expect((await f.read(prepared))?.[f.liveId]?.models[0]?.id).toBe("live-1-oauth:runtime");
    expect(await f.read(prepared, { providerDiscoveryProviderIds: [f.staticId] })).toHaveProperty(
      f.staticId,
    );
    expect(f.run).toHaveBeenCalledOnce();
    expect(plans).toHaveBeenCalledOnce();
    await f.read(prepared, { providerDiscoveryProviderIds: undefined });
    expect(plans).toHaveBeenCalledTimes(2);
    expect(f.run).toHaveBeenCalledTimes(2);
  });
});

it.each(["registry", "config", "env", "mixed", "startup"] as const)(
  "rediscovers live descriptors after %s changes",
  async (change) => {
    await using f = await fixture();
    const prepare = () => prepareImplicitProviderStaticCatalog(f.params);
    let prepared = change === "startup" ? await prepare() : await f.scope(prepare);
    const registry = change === "registry" ? createEmptyPluginRegistry() : f.pluginRegistry;
    let inputs: { config?: OpenClawConfig; env?: NodeJS.ProcessEnv } = {};
    if (change === "registry") {
      registry.providers.push(...f.pluginRegistry.providers);
      f.bind(registry);
    } else if (change === "config" || change === "env") {
      inputs =
        change === "config"
          ? { config: { ...f.config, auth: { profiles: {} } } }
          : { env: { ...f.env, DESCRIPTOR_TEST_REVISION: "next" } };
      f.bind(registry, inputs);
    } else if (change === "mixed") {
      // Derived unions cannot claim that every handle came from this runtime.
      prepared = { entries: prepared.entries, providers: prepared.providers };
    }
    using plans = vi.spyOn(modelCatalog, "planEffectiveModelCatalogRows");
    await f.scope(async () => {
      expect((await f.read(prepared, inputs))?.[f.liveId]?.models[0]?.id).toBe(
        "live-1-oauth:runtime",
      );
    }, registry);
    expect(plans).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
  },
);

it.each(["collision", "sibling"] as const)(
  "keeps an auth-only %s out of catalog replacement and OAuth preparation",
  async (kind) => {
    await using f = await fixture(true, kind);
    await f.scope(async () => {
      const prepared = await prepareImplicitProviderStaticCatalog(f.params);
      expect(prepared.providers).toContainEqual(
        expect.objectContaining({
          id: f.authId,
          resolveSyntheticAuth: expect.any(Function),
        }),
      );
      using prepare = vi.spyOn(catalogContext, "prepareProviderCatalogRun");
      using oauth = vi.spyOn(discoveryAuth, "prepareProviderCatalogOAuthAuth");
      const result = await f.read(prepared);
      expect(result?.[f.staticId]?.models[0]?.id).toBe("static-model");
      expect(result?.[f.liveId]?.models[0]?.id).toBe("live-1-oauth:runtime");
      expect(prepare.mock.calls.map(([{ provider }]) => provider.id)).toEqual([f.liveId]);
      expect(oauth).not.toHaveBeenCalled();
      if (kind === "sibling") {
        expect(result).not.toHaveProperty(f.authId);
      }
    });
  },
);

it("does not retain a registry or its old load context through prepared provenance", async () => {
  await using f = await fixture();
  const prepare = async () => {
    const registry = createEmptyPluginRegistry();
    f.bind(registry);
    const context = getPluginRuntimeLoadContextState(registry)!;
    const prepared = await f.scope(
      () =>
        prepareImplicitProviderStaticCatalog({
          ...f.params,
          providerDiscoveryProviderIds: [f.staticId],
        }),
      registry,
    );
    return { prepared, registry: new WeakRef(registry), context: new WeakRef(context) };
  };
  const retained = await prepare();
  await collectForRetentionCheck("prepared-provenance", 3);
  expect(retained.registry.deref()).toBeUndefined();
  expect(retained.context.deref()).toBeUndefined();
  using plans = vi.spyOn(modelCatalog, "planEffectiveModelCatalogRows");
  await f.scope(() => f.read(retained.prepared));
  expect(plans).toHaveBeenCalledOnce();
  expect(f.run).toHaveBeenCalledOnce();
});
