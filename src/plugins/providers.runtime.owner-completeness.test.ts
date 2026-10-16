import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as activationPlanner from "./activation-planner.js";
import {
  cleanupPluginLoaderFixturesForTest,
  clearPluginLoaderCache,
  EMPTY_PLUGIN_SCHEMA,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  writePlugin,
} from "./loader.test-fixtures.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import {
  resolveLoadedProviderPluginsForHooks,
  resolveProviderPluginsForHooks,
  resolveProviderRuntimePluginHandle,
} from "./provider-hook-runtime.js";
import { findProviderRuntimeRegistrationInRegistry } from "./provider-registry-selection.js";
import { resolvePluginProvidersCore } from "./providers.runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginRegistry } from "./registry-types.js";
import { setActivePluginRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import type { ProviderPlugin } from "./types.js";

function writeOwner(
  id: string,
  body: string,
  metadata: Partial<PluginManifestRecord> = {},
  dir?: string,
) {
  const plugin = writePlugin({ id, body, dir, filename: "index.cjs" });
  const manifest = {
    id,
    providers: [],
    configSchema: EMPTY_PLUGIN_SCHEMA,
    ...metadata,
    origin: "global" as const,
    rootDir: plugin.dir,
    source: plugin.file,
  };
  writeFileSync(path.join(plugin.dir, "openclaw.plugin.json"), JSON.stringify(manifest));
  return manifest;
}

function disableOwner(config: OpenClawConfig, id: string): OpenClawConfig {
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [id]: { enabled: false },
      },
    },
  };
}

function fixture(declaration: "setup" | "activation" | "cli", registersProvider = true) {
  const root = makePluginLoaderTempDir();
  const marker = path.join(root, "registrations.log");
  const setupSource = path.join(root, "setup.cjs");
  const helper = writeOwner(
    "helper-owner",
    `module.exports={id:"helper-owner",register(api){
      require("node:fs").appendFileSync(${JSON.stringify(marker)},"registered");
      ${registersProvider ? 'api.registerProvider({id:"helper-provider",label:"Helper",auth:[]});' : ""}
    }};`,
    {
      setupSource,
      channels: ["setup-channel"],
      ...(declaration === "setup"
        ? { setup: { providers: [{ id: "helper-provider" }] } }
        : declaration === "activation"
          ? { activation: { onProviders: ["helper-provider"] } }
          : { cliBackends: ["helper-cli"] }),
    },
    root,
  );
  const other = writeOwner(
    "other-owner",
    'module.exports={id:"other-owner",register(api){api.registerProvider({id:"other-provider",label:"Other",auth:[]});}};',
    { providers: ["other-provider"] },
  );
  writeFileSync(
    setupSource,
    'module.exports={plugin:{id:"setup-channel",meta:{id:"setup-channel",label:"Setup",selectionLabel:"Setup",docsPath:"/synthetic",blurb:"Synthetic"},capabilities:{chatTypes:["direct"]},config:{listAccountIds:()=>[],resolveAccount:()=>({})}}};',
  );
  const snapshot = createPluginMetadataSnapshotFixture({ plugins: [helper, other] });
  const config = {
    plugins: {
      allow: ["helper-owner", "other-owner"],
      entries: { "helper-owner": { enabled: true }, "other-owner": { enabled: true } },
    },
  };
  const query = {
    config,
    env: {},
    pluginMetadataSnapshot: snapshot,
    providerRefs: [declaration === "cli" ? "helper-cli" : "helper-provider", "other-provider"],
    onlyPluginIds: ["helper-owner", "other-owner"],
  };
  return {
    query,
    snapshot,
    helperSource: helper.source,
    otherSource: other.source,
    selected: (overrides: Partial<Parameters<typeof resolveProviderPluginsForHooks>[0]> = {}) =>
      labels(resolveProviderPluginsForHooks({ ...query, ...overrides })),
    loaded: (overrides: Partial<Parameters<typeof resolveLoadedProviderPluginsForHooks>[0]> = {}) =>
      labels(resolveLoadedProviderPluginsForHooks({ ...query, ...overrides })),
    inGeneration: <T>(pluginRegistry: PluginRegistry, run: () => T) =>
      withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot, pluginRegistry }, run),
    registrations: () => (existsSync(marker) ? readFileSync(marker, "utf8") : ""),
    load: (channelPluginLoadIntent: "setup" | "full", onlyPluginIds = query.onlyPluginIds) =>
      loadOpenClawPlugins({
        config,
        env: {},
        installRecords: {},
        onlyPluginIds,
        manifestRegistry: snapshot.manifestRegistry,
        channelPluginLoadIntent,
        activate: false,
      }),
  };
}

function labels(providers: readonly ProviderPlugin[] | undefined) {
  return providers?.map((provider) => provider.label);
}

afterEach(clearPluginLoaderCache);
afterAll(cleanupPluginLoaderFixturesForTest);

describe("provider selection registration coverage", () => {
  it("activates the Bedrock API owner for a custom provider without loading other owners", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../extensions/amazon-bedrock/openclaw.plugin.json", import.meta.url),
        "utf8",
      ),
    );
    const root = makePluginLoaderTempDir();
    const marker = path.join(root, "registrations.log");
    const bedrock = writeOwner(
      manifest.id,
      `module.exports={id:"amazon-bedrock",register(api){
        require("node:fs").appendFileSync(${JSON.stringify(marker)},"bedrock");
        api.registerProvider({id:"amazon-bedrock",label:"Bedrock",auth:[],hookAliases:["bedrock-converse-stream"]});
      }};`,
      manifest,
      root,
    );
    const unrelated = writeOwner(
      "unrelated-owner",
      'module.exports={id:"unrelated-owner",register(){throw new Error("unrelated owner loaded");}};',
      { providers: ["unrelated"] },
    );
    const snapshot = createPluginMetadataSnapshotFixture({ plugins: [bedrock, unrelated] });
    const config: OpenClawConfig = {
      plugins: { allow: ["amazon-bedrock", "unrelated-owner"] },
      models: {
        providers: {
          "amazon-bedrock-east1": {
            api: "bedrock-converse-stream",
            auth: "aws-sdk",
            baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
            models: [],
          },
        },
      },
    };
    const handle = resolveProviderRuntimePluginHandle({
      provider: "amazon-bedrock-east1",
      config,
      env: {},
      pluginMetadataSnapshot: snapshot,
    });
    expect(handle.plugin?.id).toBe("amazon-bedrock");
    expect(readFileSync(marker, "utf8")).toBe("bedrock");
  });

  it("reselects retained API owners from current config without activating plugins", async () => {
    const ids = ["ollama", "github-copilot"];
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: ids.map((id) => ({ id, providers: [id] })),
    });
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers = ids.map((id) => ({
      pluginId: id,
      source: `/plugins/${id}/index.js`,
      provider: { id, label: id, auth: [] },
    }));
    const config: OpenClawConfig = {
      models: {
        providers: { custom: { api: "ollama", baseUrl: "https://example.test", models: [] } },
      },
    };
    const lookup = () => resolveProviderRuntimePluginHandle({ provider: "custom", config });
    const plan = vi.spyOn(activationPlanner, "resolveManifestActivationPluginIds");
    try {
      await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
        expect(lookup().plugin?.id).toBe("ollama");
        await Promise.resolve();
        config.models!.providers!.custom!.api = "github-copilot";
        expect(lookup().plugin?.id).toBe("github-copilot");
        expect(
          withPluginRuntimeGenerationScope({ metadataSnapshot }, lookup).plugin,
        ).toBeUndefined();
        expect(plan).not.toHaveBeenCalled();
      });
    } finally {
      plan.mockRestore();
    }
  });

  it.each(["active", "retained"] as const)(
    "keeps current policy separate from a mixed %s receiver projection",
    (scope) => {
      const proof = fixture("setup");
      const loaded = proof.load("full");
      const all = ["Helper", "Other"];
      expect(loaded.providers.map(({ provider }) => provider.label)).toEqual(all);
      const query = {
        ...proof.query,
        config: disableOwner(proof.query.config, "helper-owner"),
      };
      const verify = () => {
        const expected = scope === "retained" ? all : ["Other"];
        expect(proof.loaded(query)).toEqual(expected);
        expect(proof.selected(query)).toEqual(expected);
        expect(loaded.providers.map(({ provider }) => provider.label)).toEqual(all);
        expect(proof.registrations()).toBe("registered");
        expect(proof.selected()).toEqual(all);
        expect(proof.selected({ ...query, providerRefs: ["other-provider"] })).toEqual(["Other"]);
        expect(proof.selected({ ...query, providerRefs: ["helper-provider"] })).toEqual(
          scope === "retained" ? ["Helper"] : [],
        );
        expect(labels(resolvePluginProvidersCore({ ...query, registryScope: "exact" }))).toEqual(
          expected,
        );
      };
      if (scope === "retained") {
        proof.inGeneration(loaded, verify);
      } else {
        setActivePluginRegistry(loaded, "mixed-current-policy");
        verify();
      }
    },
  );

  it("runs an activation helper beside the declared provider without projecting it as the receiver", () => {
    const proof = fixture("activation", false, "other-provider");
    expect(
      labels(resolveProviderPluginsForHooks({ ...proof.query, providerRefs: ["other-provider"] })),
    ).toEqual(["Other"]);
    expect(proof.registrations()).toBe("registered");
  });

  it.each([
    "missing helper",
    "disabled alias owner",
    "replaced alias owner",
    "retained disabled owner",
  ] as const)("resolves runtime aliases beside activation helpers in the %s registry", (scope) => {
    const proof = fixture("activation", false);
    const aliasCalls = path.join(path.dirname(proof.otherSource), "alias-calls");
    writeFileSync(
      proof.otherSource,
      `module.exports={id:"other-owner",register(api){api.registerProvider({id:"other-provider",label:"Other",auth:[],hookAliases:["helper-provider"],normalizeModelId(){require("node:fs").appendFileSync(${JSON.stringify(aliasCalls)}, "called");return "alias-current";}});}};`,
    );
    const blockedAlias = scope === "disabled alias owner" || scope === "replaced alias owner";
    const missingHelper = scope === "missing helper" || scope === "replaced alias owner";
    const loaded = proof.load("full", missingHelper ? ["other-owner"] : undefined);
    expect(proof.registrations()).toBe(missingHelper ? "" : "registered");
    const unexpectedImport = path.join(path.dirname(proof.otherSource), "replacement-imported");
    const replacementSource = path.join(path.dirname(proof.otherSource), "replacement.cjs");
    if (scope === "replaced alias owner") {
      writeFileSync(
        replacementSource,
        `require("node:fs").writeFileSync(${JSON.stringify(unexpectedImport)}, "imported");
          module.exports={id:"other-owner",register(api){api.registerProvider({id:"other-provider",label:"Replacement",auth:[],hookAliases:["helper-provider"]});}};`,
      );
    }
    const query = {
      ...proof.query,
      config:
        scope === "disabled alias owner" || scope === "retained disabled owner"
          ? disableOwner(proof.query.config, "other-owner")
          : proof.query.config,
      pluginMetadataSnapshot:
        scope === "replaced alias owner"
          ? createPluginMetadataSnapshotFixture({
              plugins: proof.snapshot.plugins.map((plugin) =>
                plugin.id === "other-owner" ? { ...plugin, source: replacementSource } : plugin,
              ),
            })
          : proof.snapshot,
      providerRefs: ["helper-provider"],
      onlyPluginIds: missingHelper ? undefined : proof.query.onlyPluginIds,
    };
    const verify = () => {
      expect(proof.loaded(query)).toEqual(missingHelper || blockedAlias ? undefined : ["Other"]);
      expect(proof.registrations()).toBe(missingHelper ? "" : "registered");
      expect(proof.selected(query)).toEqual(blockedAlias ? [] : ["Other"]);
      // Disabling A creates a new policy/scope key; the helper completes once in
      // that new registry, in addition to its original warm registration.
      const expectedRegistrations =
        scope === "disabled alias owner" ? "registeredregistered" : "registered";
      expect(proof.registrations()).toBe(expectedRegistrations);
      const handle = resolveProviderRuntimePluginHandle({ ...query, provider: "helper-provider" });
      expect(handle.plugin?.id).toBe(blockedAlias ? undefined : "other-provider");
      expect(
        handle.plugin?.normalizeModelId?.({ provider: "helper-provider", modelId: "legacy" }),
      ).toBe(blockedAlias ? undefined : "alias-current");
      expect(existsSync(aliasCalls) ? readFileSync(aliasCalls, "utf8") : "").toBe(
        blockedAlias ? "" : "called",
      );
      expect(proof.registrations()).toBe(expectedRegistrations);
      expect(existsSync(unexpectedImport)).toBe(false);
      expect(proof.selected({ ...query, onlyPluginIds: ["helper-owner"] })).toEqual([]);
    };
    if (scope === "retained disabled owner") {
      proof.inGeneration(loaded, verify);
    } else {
      setActivePluginRegistry(loaded, "active-alias");
      verify();
    }
  });

  it("keeps a failed declared receiver reserved for raw parser and hook lookups", () => {
    const proof = fixture("setup");
    writeFileSync(
      proof.helperSource,
      'module.exports={id:"helper-owner",register(){throw new Error("synthetic registration failure");}};',
    );
    writeFileSync(
      proof.otherSource,
      'module.exports={id:"other-owner",register(api){api.registerProvider({id:"other-provider",label:"Other",auth:[],hookAliases:["helper-provider"],normalizeModelId:()=>"wrong-owner"});}};',
    );
    const registry = proof.load("full");
    setActivePluginRegistry(registry, "failed-receiver");
    const lookup = () =>
      findProviderRuntimeRegistrationInRegistry({
        registry,
        provider: "helper-provider",
        ownerRefs: [],
      });
    expect(lookup()).toBeUndefined();
    proof.inGeneration(registry, () => {
      expect(lookup()).toBeUndefined();
      expect(proof.selected({ providerRefs: ["helper-provider"] })).toEqual([]);
    });
    expect(proof.selected({ providerRefs: ["helper-provider"] })).toEqual([]);
  });

  it("completes a provider selected through setup metadata", () => {
    const proof = fixture("setup");
    const partial = proof.load("setup");
    setActivePluginRegistry(partial, "partial");
    expect(partial.providers.map((entry) => entry.provider.label)).toEqual(["Other"]);
    expect(proof.loaded()).toBeUndefined();
    expect(proof.selected()).toEqual(["Helper", "Other"]);
    expect(proof.load("full").providers.map((entry) => entry.provider.label)).toEqual([
      "Helper",
      "Other",
    ]);
  });

  it("reuses a complete active registry after a partial request with activation metadata", () => {
    const proof = fixture("activation");
    const partial = proof.load("setup");
    const complete = proof.load("full");
    setActivePluginRegistry(complete, "complete-active");
    expect(partial.providers.map(({ provider }) => provider.label)).toEqual(["Other"]);
    withPluginRuntimeRegistryScope(partial, () => {
      expect(proof.loaded()).toEqual(["Helper", "Other"]);
      expect(proof.selected()).toEqual(["Helper", "Other"]);
    });
    expect(proof.registrations()).toBe("registered");
  });

  it("completes a non-provider activation helper's setup registration", () => {
    const proof = fixture("activation", false);
    const registry = proof.load("setup");
    setActivePluginRegistry(registry, "setup");
    expect(proof.registrations()).toBe("");
    proof.inGeneration(registry, () => {
      expect(proof.selected()).toEqual(["Other"]);
      expect(proof.registrations()).toBe("");
    });
    expect(proof.loaded()).toBeUndefined();
    expect(proof.selected()).toEqual(["Other"]);
    expect(proof.registrations()).toBe("registered");
  });

  it("does not require provider registration from a CLI-backend-only owner", () => {
    const proof = fixture("cli", false);
    setActivePluginRegistry(proof.load("setup"), "cli-only");
    expect(proof.loaded()).toEqual(["Other"]);
    expect(proof.selected()).toEqual(["Other"]);
    expect(proof.registrations()).toBe("");
  });
});
