import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "./plugin-metadata.test-support.js";
import { listTrustedExternalProviderPolicyOwners } from "./provider-policy-owners.js";
import { resolveDirectBundledProviderPolicySurface } from "./provider-policy-surface.js";
import {
  loadProviderPolicyArtifacts as loadArtifacts,
  resolveBundledProviderPolicySurface,
  resolveProviderPolicySurface,
} from "./provider-public-artifacts.js";
import {
  prepareModelCatalogThinkingPolicies,
  resolveEffectiveThinkingProfile,
} from "./provider-thinking.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeExternalPolicyFixture(): string {
  const pluginRoot = tempDirs.make("openclaw-provider-policy-external-");
  // Policy artifacts must use ESM, independent of the host's syntax detection.
  fs.writeFileSync(path.join(pluginRoot, "package.json"), '{ "type": "module" }\n', "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "provider-policy-api.js"),
    [
      "export function resolveThinkingProfile({ modelId }) {",
      '  return modelId === "full"',
      '    ? { levels: [{ id: "off" }, { id: "high" }, { id: "max" }], defaultLevel: "off" }',
      '    : { levels: [{ id: "off" }, { id: "low", label: "on" }], defaultLevel: "off" };',
      "}",
      "export function inspectEmbeddingProviderSetup({ provider }) {",
      '  return provider === "fixture-embedding"',
      '    ? { provider, reason: "setup missing", requirement: "fixture-setup" }',
      "    : null;",
      "}",
      "export function projectConfiguredModelRow() { return null; }",
      "",
    ].join("\n"),
    "utf8",
  );
  return pluginRoot;
}

function externalOwner(rootDir: string, id = "fixture-provider", providers = [id]) {
  return {
    id,
    rootDir,
    providers,
    origin: "external",
    trustedOfficialInstall: true,
    cliBackends: [],
    contracts: { embeddingProviders: ["fixture-embedding"] },
  } as const;
}

function mockBundledPolicy(resolve: (dirName: string) => object | null) {
  const load = vi.fn(({ dirName }: { dirName: string }) => resolve(dirName));
  vi.doMock("./public-surface-loader.js", () => ({
    loadBundledPluginPublicArtifactModuleFromCandidatesSync: load,
  }));
  return load;
}

function resolveExternal(provider: string, ...plugins: PluginManifestRecord[]) {
  return resolveProviderPolicySurface(provider, { manifestRegistry: { plugins } });
}

async function freshPolicyResolver(scope: string) {
  const module = await importFreshModule<typeof import("./provider-public-artifacts.js")>(
    import.meta.url,
    `./provider-public-artifacts.js?scope=${scope}`,
  );
  return module.resolveBundledProviderPolicySurface;
}

describe("provider public artifacts", () => {
  function useBundledDir() {
    const dir = tempDirs.make("openclaw-provider-policy-bundled-");
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", dir);
    vi.stubEnv("OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR", "1");
    return dir;
  }

  beforeEach(() => {
    vi.resetModules();
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("./manifest-registry.js");
    vi.doUnmock("./public-surface-loader.js");
  });

  it.each(["my-ngc:nvidia", "my-ngc/nvidia", "my-ngc\\nvidia", ".", ".."])(
    "does not treat path-like provider %s as a bundled plugin directory",
    (providerId) => {
      expect(resolveDirectBundledProviderPolicySurface(providerId)).toBeNull();
      expect(resolveBundledProviderPolicySurface(providerId)).toBeNull();
      expect(resolveProviderPolicySurface(providerId)).toBeNull();
    },
  );

  it("selects the first equal-id bundled owner in stable lexical order", async () => {
    vi.doMock("./bundled-dir.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./bundled-dir.js")>()),
      resolveBundledPluginsDir: () => "/fixture",
    }));
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync: ({
        dirName,
      }: {
        dirName: string;
      }) =>
        dirName.endsWith("-root")
          ? { resolveThinkingProfile: () => ({ levels: [{ id: dirName }] }) }
          : null,
    }));
    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=stable-owner-order");
    const owner = (id: string, root: string) =>
      createPluginManifestRecordFixture({
        id,
        rootDir: `/fixture/${root}-root`,
        providers: ["fixture-provider"],
      });
    const last = owner("z-owner", "last");
    const first = owner("a-owner", "first");
    const equal = owner("a-owner", "equal");
    const external = { ...owner("0-owner", "external"), origin: "global" as const };
    const earlierUnrelated = { ...owner("0-unrelated", "unrelated"), providers: ["other"] };
    const plugins = [last, external, first, earlierUnrelated, equal];

    expect(
      resolvePolicySurface("fixture-provider", {
        manifestRegistry: { plugins },
      })?.resolveThinkingProfile?.({ provider: "fixture-provider", modelId: "demo" }),
    ).toEqual({ levels: [{ id: "first-root" }] });
    expect(plugins).toEqual([last, external, first, earlierUnrelated, equal]);
  });

  it("loads a lightweight bundled provider policy artifact smoke", () => {
    const surface = resolveBundledProviderPolicySurface("openai");
    expect(surface?.normalizeConfig).toBeTypeOf("function");
    expect(surface?.projectConfiguredModelRow).toBeTypeOf("function");

    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [],
    };
    expect(
      surface?.normalizeConfig?.({
        provider: "openai",
        providerConfig,
      }),
    ).toBe(providerConfig);
    expect(
      surface
        ?.resolveThinkingProfile?.({ provider: "openai", modelId: "gpt-5.5" })
        ?.levels.map((level) => level.id),
    ).toContain("xhigh");
    expect(surface?.resolveModelRoutes?.({ provider: "openai", modelId: "gpt-5.5" })).toEqual({
      kind: "routes",
      defaultRuntimeId: "codex",
      preferredAuthRequirement: "subscription",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex", "agentsapi"] },
        },
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    });
  });

  it("loads Kimi Code K3 thinking policy before runtime registration", () => {
    const surface = resolveBundledProviderPolicySurface("kimi");

    expect(
      surface?.resolveThinkingProfile?.({
        provider: "kimi",
        modelId: "k3",
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "adaptive" },
        { id: "xhigh" },
        { id: "max" },
      ],
      defaultLevel: "high",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it.each(["opencode", "opencode-go"])(
    "preserves %s effort metadata before runtime registration",
    (provider) => {
      const surface = resolveBundledProviderPolicySurface(provider);
      const cases = [
        [undefined, undefined, undefined],
        [null, undefined, undefined],
        [[], undefined, undefined],
        [["none", "off"], ["off"], "off"],
        [["max", "high", "low", "high", "none"], ["off", "low", "high", "max"], "high"],
        [
          ["high", "medium", "low", "minimal", "xhigh"],
          ["off", "minimal", "low", "medium", "high", "xhigh"],
          "medium",
        ],
        [["low"], ["off", "low"], "low"],
        [["minimal", "xhigh", "max"], ["off", "minimal", "xhigh", "max"], "off"],
        [["adaptive", "ultra", "HIGH", " low ", "provider-native", ""], ["off"], "off"],
      ] as const;
      for (const [efforts, levelIds, defaultLevel] of cases) {
        expect(
          surface?.resolveThinkingProfile?.({
            provider,
            modelId: "effort-fixture",
            compat: { supportedReasoningEfforts: efforts },
          }),
          JSON.stringify(efforts),
        ).toEqual(levelIds ? { levels: levelIds.map((id) => ({ id })), defaultLevel } : undefined);
      }
      expect(
        surface?.resolveThinkingProfile?.({
          provider,
          modelId: "effort-fixture",
          api: "openai-responses",
          reasoning: true,
          compat: { supportedReasoningEfforts: [] },
        }),
      ).toEqual(
        provider === "opencode"
          ? { levels: [{ id: "off", label: "always on" }], defaultLevel: "off" }
          : undefined,
      );
    },
  );

  it("loads OpenCode Go model overrides before runtime registration", () => {
    const surface = resolveBundledProviderPolicySurface("opencode-go");

    for (const [modelId, levelIds, defaultLevel] of [
      ["deepseek-v4-pro", ["off", "low"], "low"],
      ["kimi-k3", ["off", "low"], "low"],
      ["kimi-k2.6", ["off"], "off"],
    ] as const) {
      expect(
        surface?.resolveThinkingProfile?.({
          provider: "opencode-go",
          modelId,
          compat: { supportedReasoningEfforts: ["low"] },
        }),
      ).toEqual({ levels: levelIds.map((id) => ({ id })), defaultLevel });
    }
    for (const modelId of ["minimax-m2.7", "minimax-m3"]) {
      expect(
        surface?.resolveThinkingProfile?.({
          provider: "opencode-go",
          modelId,
          api: "anthropic-messages",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["low"] },
        }),
      ).toEqual({ levels: [{ id: "off" }, { id: "low" }], defaultLevel: "low" });
    }
    expect(
      surface?.resolveThinkingProfile?.({ provider: "opencode-go", modelId: "glm-5" }),
    ).toBeUndefined();
  });

  it("loads trusted namespaced external provider policy before runtime registration", () => {
    useBundledDir();
    const pluginRoot = writeExternalPolicyFixture();
    const fixturePlugin = externalOwner(pluginRoot, "fixture-provider", ["fixture:nvidia"]);
    const surface = resolveExternal("fixture:nvidia", fixturePlugin as never);
    const embedding = resolveExternal("fixture-embedding", fixturePlugin as never);
    const profile = (modelId: string) =>
      surface?.resolveThinkingProfile?.({ provider: "fixture:nvidia", modelId });

    expect(profile("full")?.levels.map((level) => level.id)).toEqual(["off", "high", "max"]);
    expect(profile("legacy")?.levels.map((level) => level.label)).toEqual([undefined, "on"]);
    expect(surface).not.toHaveProperty("projectConfiguredModelRow");
    expect(
      embedding?.inspectEmbeddingProviderSetup?.({
        config: {},
        env: {},
        agentId: "main",
        provider: "fixture-embedding",
      }),
    ).toEqual({
      provider: "fixture-embedding",
      reason: "setup missing",
      requirement: "fixture-setup",
    });
  });

  it.each(["bundled", "untrusted", "cold", "loaded", "catalog", "evaluation-error"] as const)(
    "keeps provider policy under its admitted owner (%s)",
    async (scenario) => {
      const rootDir = writeExternalPolicyFixture();
      const source = path.join(rootDir, "index.cjs");
      const policy = path.join(rootDir, "provider-policy-api.js");
      const activation = path.join(rootDir, "runtime-activated");
      const event = `external-policy:${rootDir}`;
      fs.writeFileSync(
        source,
        `require('node:fs').writeFileSync(${JSON.stringify(activation)}, 'unexpected'); throw new Error('runtime entry must stay cold');`,
      );
      const writePolicy = (value: string) =>
        fs.writeFileSync(
          policy,
          `process.on(${JSON.stringify(event)}, () => {}); export function resolveThinkingProfile() { return { levels: [{ id: 'off' }], defaultLevel: ${JSON.stringify(value)} }; }`,
        );
      writePolicy("before");
      const metadata = createPluginManifestRecordFixture({
        id: "fixture-policy",
        rootDir,
        source,
        origin: scenario === "bundled" ? "bundled" : "global",
        trustedOfficialInstall: scenario !== "untrusted" && scenario !== "bundled",
        providers: ["fixture-policy"],
      });
      const cache = createPluginCache();
      const ambient = createPluginCache();
      const snapshot = withPluginCache(cache, () =>
        createPluginMetadataSnapshotFixture({ plugins: [metadata] }),
      );
      const registry = createEmptyPluginRegistry();
      let instance: PluginInstance | undefined;
      try {
        if (scenario === "loaded") {
          const record = createPluginRecord({ id: metadata.id, rootDir, source, origin: "global" });
          registry.plugins.push(record);
          const loadedInstance = new PluginInstance(record.id, { record, registry });
          instance = loadedInstance;
          withPluginCache(cache, () =>
            bindPluginInstanceModuleLoader({
              instance: loadedInstance,
              origin: record.origin,
              source,
              rootDir,
            }),
          );
          instance.loadModule(policy);
          writePolicy("after");
        }
        if (scenario === "evaluation-error") {
          fs.writeFileSync(
            policy,
            "throw new Error('Unable to resolve plugin public surface nested failure');",
          );
        }
        const resolve = () =>
          withPluginRuntimeRegistryScope(registry, () =>
            withPluginCache(cache, () => loadArtifacts([metadata])?.surface),
          );
        if (scenario === "catalog") {
          const catalog: ModelCatalogSnapshot = {
            entries: [{ id: "fixture", name: "fixture", provider: metadata.id }],
            routeVariants: [],
          };
          withPluginRuntimeRegistryScope(registry, () =>
            withPluginCache(ambient, () =>
              prepareModelCatalogThinkingPolicies({ catalog, metadataSnapshot: snapshot }),
            ),
          );
          expect(ambient.setupModules.size).toBe(0);
          expect(cache.setupModules.size).toBe(1);
          const read = () =>
            resolveEffectiveThinkingProfile({
              provider: metadata.id,
              context: { provider: metadata.id, modelId: "fixture" },
              catalogEntry: catalog.entries[0],
            });
          expect(read()?.defaultLevel).toBe("before");
          await retirePluginCache(cache);
          expect(read).toThrow();
        } else if (scenario === "evaluation-error") {
          expect(resolve).toThrow("nested failure");
        } else {
          const policySurface = resolve();
          if (scenario === "untrusted") {
            expect(policySurface).toBeNull();
            expect(process.listenerCount(event)).toBe(0);
          } else {
            const callback = policySurface?.resolveThinkingProfile;
            if (!callback) {
              throw new Error("Expected the trusted policy callback");
            }
            const context = { provider: metadata.id, modelId: "fixture" };
            expect(callback?.(context)?.defaultLevel).toBe("before");
            expect(getPluginValueInstance(callback)).toBeDefined();
            expect(process.listenerCount(event)).toBe(1);
            if (scenario === "loaded") {
              expect(getPluginValueInstance(callback)).toBe(instance);
              expect(cache.setupModules.size).toBe(0);
              await instance?.dispose();
              expect(() => callback(context)).toThrow();
            } else {
              expect(cache.setupModules.size).toBe(1);
              await retirePluginCache(cache);
              expect(() => callback?.(context)).toThrow();
              expect(resolve).toThrow("retired");
            }
          }
        }
      } finally {
        await instance?.dispose();
        await retirePluginCache(cache);
        await retirePluginCache(ambient);
        const remainingListeners = process.listenerCount(event);
        const runtimeActivated = fs.existsSync(activation);
        process.removeAllListeners(event);
        expect(remainingListeners).toBe(
          scenario === "untrusted" || scenario === "evaluation-error" ? 0 : 1,
        );
        expect(runtimeActivated).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "retains a missing-artifact owner or finds a later policy (later=%s)",
    (later) => {
      const root = tempDirs.make("openclaw-provider-owner-missing-");
      const missing = externalOwner(root, "a-missing-policy", []) as never;
      const plugins: PluginManifestRecord[] = [missing];
      if (later) {
        plugins.push(externalOwner(writeExternalPolicyFixture(), "b-policy", []) as never);
      }
      const owners = listTrustedExternalProviderPolicyOwners("fixture-embedding", { plugins });
      const artifacts = loadArtifacts(owners);
      if (later) {
        expect(artifacts?.owner.id).toBe("b-policy");
        expect(artifacts?.surface?.inspectEmbeddingProviderSetup).toBeTypeOf("function");
      } else {
        expect(artifacts).toEqual({ owner: missing, surface: null });
        expect(resolveExternal("fixture-embedding", missing)).toBeNull();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects trusted official provider policy artifacts hardlinked outside the installed root",
    () => {
      const tempRoot = tempDirs.make("openclaw-provider-policy-hardlink-");
      const pluginRoot = path.join(tempRoot, "installed-provider");
      const outsidePath = path.join(tempRoot, "outside-policy.js");
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        outsidePath,
        'export function resolveThinkingProfile() { return { defaultLevel: "escaped" }; }\n',
        "utf8",
      );
      fs.linkSync(outsidePath, path.join(pluginRoot, "provider-policy-api.js"));

      const pluginId = "hardlinked-provider";
      const owner = { ...externalOwner(pluginRoot, pluginId), origin: "global" } as never;
      expect(() => resolveExternal(pluginId, owner)).toThrow(
        "Unable to open plugin public surface provider-policy-api.js",
      );
    },
  );

  it.each([false, true])(
    "does not load public policy code from untrusted external plugins (configured=%s)",
    (configured) => {
      const pluginRoot = writeExternalPolicyFixture();
      expect(
        resolveProviderPolicySurface("fixture-provider", {
          config: configured ? { plugins: { allow: ["fixture-provider"] } } : undefined,
          manifestRegistry: {
            plugins: [{ ...externalOwner(pluginRoot), trustedOfficialInstall: false } as never],
          },
        }),
      ).toBeNull();
    },
  );

  it("resolves bundled policy artifacts through provider auth aliases", async () => {
    const loadPluginManifestRegistry = forbidManifestRegistryScan();
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(
      ({ dirName }: { dirName: string }) => {
        if (dirName !== "xai") {
          return null;
        }
        return {
          resolveThinkingProfile: ({ provider, modelId }: { provider: string; modelId: string }) =>
            provider === "x-ai" && modelId === "grok-4.5"
              ? {
                  levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
                  defaultLevel: "high",
                }
              : { levels: [{ id: "off" }], defaultLevel: "off" },
        };
      },
    );

    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=provider-auth-alias");

    const surface = resolvePolicySurface("x-ai", {
      manifestRegistry: {
        plugins: [
          {
            id: "xai",
            channels: [],
            cliBackends: [],
            hooks: [],
            origin: "bundled",
            manifestPath: "/tmp/xai/openclaw.plugin.json",
            providers: ["xai"],
            providerAuthAliases: { "x-ai": "xai" },
            rootDir: "/tmp/xai",
            skills: [],
            source: "/tmp/xai/index.js",
          },
        ],
      },
    });

    expect(surface?.resolveThinkingProfile?.({ provider: "x-ai", modelId: "grok-4.5" })).toEqual({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "high",
    });
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledWith({
      dirName: "xai",
      artifactCandidates: ["provider-policy-api.js"],
    });
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("resolves bundled policy artifacts for a plugin-owned CLI backend", async () => {
    const loadPluginManifestRegistry = vi.fn(() => {
      throw new Error("unexpected manifest registry scan");
    });
    vi.doMock("./manifest-registry.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./manifest-registry.js")>()),
      loadPluginManifestRegistryCore: loadPluginManifestRegistry,
    }));
    const loadArtifact = mockBundledPolicy((dirName) =>
      dirName === "anthropic"
        ? {
            resolveThinkingProfile: ({ provider }: { provider: string }) => ({
              levels: [{ id: provider }],
            }),
          }
        : null,
    );

    const resolvePolicySurface = await freshPolicyResolver("provider-cli-backend");

    // CLI backend ids use the same provider-policy owner boundary as provider ids.
    // Without it, claude-cli subagents fall back to the base thinking profile.
    const surface = resolvePolicySurface("claude-cli", {
      manifestRegistry: {
        plugins: [
          createPluginManifestRecordFixture({
            id: "anthropic",
            cliBackends: ["claude-cli"],
            providers: ["anthropic"],
          }),
        ],
      },
    });

    expect(
      surface?.resolveThinkingProfile?.({ provider: "claude-cli", modelId: "claude-opus-4-8" }),
    ).toEqual({ levels: [{ id: "claude-cli" }] });
    expect(loadArtifact).toHaveBeenCalledWith({
      dirName: "anthropic",
      artifactCandidates: ["provider-policy-api.js"],
    });
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("keeps manifest-owned provider policy aliases stable until a new operation", async () => {
    const bundledPluginsDir = useBundledDir();
    const writePlugin = (pluginId: string, providers: string[], version: number) => {
      const pluginDir = path.join(bundledPluginsDir, pluginId);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          name: `${pluginId} ${version}`,
          configSchema: { type: "object" },
          providers,
        }),
      );
      fs.writeFileSync(
        path.join(pluginDir, "index.js"),
        "export default { register() {} };\n",
        "utf8",
      );
    };

    mockBundledPolicy((dirName) =>
      dirName === "first" || dirName === "second"
        ? {
            resolveThinkingProfile: () => ({ levels: [{ id: dirName }] }),
          }
        : null,
    );
    writePlugin("first", ["fixture-provider"], 1);
    writePlugin("second", [], 1);
    const resolvePolicySurface = await freshPolicyResolver("provider-alias-refresh");

    const owner = createPluginCache();
    const levels = () =>
      resolvePolicySurface("fixture-provider")
        ?.resolveThinkingProfile?.({ provider: "fixture-provider", modelId: "demo" })
        ?.levels.map((level) => level.id);
    expect(withPluginCache(owner, levels)).toEqual(["first"]);

    writePlugin("first", [], 2);
    writePlugin("second", ["fixture-provider"], 2);
    clearPluginMetadataLifecycleCaches();

    expect(withPluginCache(owner, levels)).toEqual(["first"]);
    expect(withPluginCache(createPluginCache(), levels)).toEqual(["second"]);
  });

  it("uses caller-provided manifest metadata for provider policy aliases", async () => {
    const loadPluginManifestRegistry = forbidManifestRegistryScan();
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(
      ({ dirName }: { dirName: string }) => {
        if (dirName !== "owner") {
          return null;
        }
        return {
          resolveThinkingProfile: () => ({ levels: [{ id: dirName }] }),
        };
      },
    );

    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=provider-alias-manifest");

    const surface = resolvePolicySurface("alias", {
      manifestRegistry: {
        plugins: [
          {
            id: "owner",
            channels: [],
            cliBackends: [],
            hooks: [],
            origin: "bundled",
            manifestPath: "/tmp/owner/openclaw.plugin.json",
            providers: ["alias"],
            rootDir: "/tmp/owner",
            skills: [],
            source: "/tmp/owner/index.js",
          },
        ],
      },
    });

    expect(surface?.resolveThinkingProfile?.({ provider: "alias", modelId: "demo" })).toEqual({
      levels: [{ id: "owner" }],
    });
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("keeps canonical provider policy lookup on the direct artifact path", async () => {
    const loadArtifact = mockBundledPolicy(() => ({
      normalizeConfig: (ctx: { providerConfig: ModelProviderConfig }) => ctx.providerConfig,
    }));

    const resolvePolicySurface = await freshPolicyResolver("no-runtime-deps");

    const manifestRegistry = {
      get plugins(): never {
        throw new Error("direct provider policy lookup must not inspect manifest metadata");
      },
    };
    const surface = resolvePolicySurface("openai", { manifestRegistry });
    expect(surface?.normalizeConfig).toBeTypeOf("function");
    expect(loadArtifact).toHaveBeenCalledWith({
      dirName: "openai",
      artifactCandidates: ["provider-policy-api.js"],
    });
  });

  it("recognizes resolveModelRoutes as a standalone provider policy surface", async () => {
    const resolveModelRoutes = vi.fn(() => ({
      kind: "routes" as const,
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://fixture.example.test/v1",
          authRequirement: "api-key" as const,
          requestTransportOverrides: "none" as const,
        },
      ] as const,
    }));
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
      resolveModelRoutes,
    }));
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=model-routes-only");

    const surface = resolvePolicySurface("openai");
    expect(surface?.resolveModelRoutes?.({ provider: "openai" })).toEqual({
      kind: "routes",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://fixture.example.test/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
        },
      ],
    });
  });
});
