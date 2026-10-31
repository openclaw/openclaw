// Verifies provider public artifacts extracted from plugin metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { captureEnv } from "../test-utils/env.js";
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
  loadProviderPolicyArtifacts,
  loadProviderPolicyArtifactsAsync,
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
  // Shipped policy artifacts are ESM in a "type": "module" package; an ambiguous
  // .js file would depend on the host loader's syntax detection instead.
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
      "export function projectRealtimeVoicePublicProjection() { return null; }",
      "",
    ].join("\n"),
    "utf8",
  );
  return pluginRoot;
}

function forbidManifestRegistryScan() {
  const loadPluginManifestRegistry = vi.fn(() => {
    throw new Error("unexpected manifest registry scan");
  });
  vi.doMock("./manifest-registry.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./manifest-registry.js")>()),
    loadPluginManifestRegistryCore: loadPluginManifestRegistry,
  }));
  return loadPluginManifestRegistry;
}

async function loadPolicyResolver(scope: string, loader: (params: { dirName: string }) => unknown) {
  vi.doMock("./public-surface-loader.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./public-surface-loader.js")>()),
    loadBundledPluginPublicArtifactModuleFromCandidatesSync: loader,
  }));
  return (
    await importFreshModule<typeof import("./provider-public-artifacts.js")>(
      import.meta.url,
      `./provider-public-artifacts.js?scope=${scope}`,
    )
  ).resolveBundledProviderPolicySurface;
}

async function loadOwnedPolicyResolver(
  scope: string,
  owner: string,
  surface: Record<string, unknown>,
) {
  const scan = forbidManifestRegistryScan();
  const loadArtifact = vi.fn(({ dirName }: { dirName: string }) =>
    dirName === owner ? surface : null,
  );
  const resolve = await loadPolicyResolver(scope, loadArtifact);
  return { resolve, loadArtifact, scan };
}

function externalPolicyOwner(rootDir: string, provider = "fixture-provider") {
  return createPluginManifestRecordFixture({
    id: "fixture-provider",
    origin: "global",
    trustedOfficialInstall: true,
    rootDir,
    providers: [provider],
    contracts: { embeddingProviders: ["fixture-embedding"] },
  });
}

function isolateBundledPlugins() {
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tempDirs.make("openclaw-empty-bundled-plugins-");
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
}

describe("provider public artifacts", () => {
  const bundledPluginEnv = captureEnv([
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
    "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  ]);

  beforeEach(() => {
    vi.resetModules();
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    bundledPluginEnv.restore();
    vi.doUnmock("./bundled-dir.js");
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
    const resolvePolicySurface = await loadPolicyResolver("stable-owner-order", ({ dirName }) =>
      dirName.endsWith("-root")
        ? { resolveThinkingProfile: () => ({ levels: [{ id: dirName }] }) }
        : null,
    );
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
    expect(surface?.projectRealtimeVoicePublicProjection).toBeTypeOf("function");
    expect(surface?.resolveModelRoutes).toBeTypeOf("function");

    expect(
      surface
        ?.resolveThinkingProfile?.({ provider: "openai", modelId: "gpt-5.5" })
        ?.levels.map((level) => level.id),
    ).toContain("xhigh");
  });

  it("loads Kimi Code K3 thinking policy before runtime registration", () => {
    const surface = resolveBundledProviderPolicySurface("kimi");

    expect(
      surface?.resolveThinkingProfile?.({
        provider: "kimi",
        modelId: "k3",
      }),
    ).toEqual({
      levels: ["off", "minimal", "low", "medium", "high", "adaptive", "xhigh", "max"].map((id) => ({
        id,
      })),
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

  it("loads trusted official external provider policy before runtime registration", () => {
    isolateBundledPlugins();
    const pluginRoot = writeExternalPolicyFixture();
    const fixturePlugin = externalPolicyOwner(pluginRoot);
    const surface = resolveProviderPolicySurface("fixture-provider", {
      manifestRegistry: { plugins: [fixturePlugin] },
    });

    expect(
      surface
        ?.resolveThinkingProfile?.({ provider: "fixture-provider", modelId: "full" })
        ?.levels.map((level) => level.id),
    ).toEqual(["off", "high", "max"]);
    expect(
      surface
        ?.resolveThinkingProfile?.({ provider: "fixture-provider", modelId: "legacy" })
        ?.levels.map((level) => level.label),
    ).toEqual([undefined, "on"]);
    expect(surface).not.toHaveProperty("projectRealtimeVoicePublicProjection");
    expect(
      resolveProviderPolicySurface("fixture-embedding", {
        manifestRegistry: { plugins: [fixturePlugin] },
      })?.inspectEmbeddingProviderSetup?.({
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
            withPluginCache(cache, () => loadProviderPolicyArtifacts([metadata])?.surface),
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
        fs.rmSync(rootDir, { recursive: true, force: true });
        expect(remainingListeners).toBe(
          scenario === "untrusted" || scenario === "evaluation-error" ? 0 : 1,
        );
        expect(runtimeActivated).toBe(false);
      }
    },
  );

  it("prepares independent cold policy callbacks without activating the runtime", async () => {
    const rootDir = writeExternalPolicyFixture();
    const source = path.join(rootDir, "index.cjs");
    const activation = path.join(rootDir, "runtime-activated");
    fs.writeFileSync(
      source,
      `require('node:fs').writeFileSync(${JSON.stringify(activation)}, 'bad');`,
    );
    fs.writeFileSync(
      path.join(rootDir, "provider-policy-api.js"),
      "let calls = 0; export function resolveThinkingProfile() { return { defaultLevel: String(++calls), levels: [{ id: 'off' }] }; }",
    );
    const owner = createPluginManifestRecordFixture({
      ...externalPolicyOwner(rootDir),
      source,
    });
    const first = createPluginCache();
    const second = createPluginCache();
    try {
      const read = (cache: typeof first) =>
        withPluginCache(cache, () => loadProviderPolicyArtifactsAsync([owner]));
      const a = (await read(first))?.surface?.resolveThinkingProfile;
      const b = (await read(second))?.surface?.resolveThinkingProfile;
      expect(a).toBeTypeOf("function");
      expect(b).toBeTypeOf("function");
      const context = { provider: owner.id, modelId: "fixture" };
      expect(a?.(context)?.defaultLevel).toBe("1");
      expect(a?.(context)?.defaultLevel).toBe("2");
      expect(b?.(context)?.defaultLevel).toBe("1");
      expect(fs.existsSync(activation)).toBe(false);
      await retirePluginCache(first);
      expect(() => a?.(context)).toThrow();
      expect(b?.(context)?.defaultLevel).toBe("2");
    } finally {
      await retirePluginCache(first);
      await retirePluginCache(second);
    }
  });

  it("does not try another policy owner after cold evaluation failure", async () => {
    const broken = writeExternalPolicyFixture();
    const fallback = writeExternalPolicyFixture();
    fs.writeFileSync(
      path.join(broken, "provider-policy-api.js"),
      "throw new Error('policy failed');",
    );
    const cache = createPluginCache();
    try {
      await expect(
        withPluginCache(cache, () =>
          loadProviderPolicyArtifactsAsync([
            externalPolicyOwner(broken),
            externalPolicyOwner(fallback),
          ]),
        ),
      ).rejects.toThrow("policy failed");
      expect(cache.setupModules.size).toBe(0);
    } finally {
      await retirePluginCache(cache);
    }
  });

  it("does not bind a cold policy after preparation loses its authority", async () => {
    const { AsyncWorkScope } = await import("../shared/async-work-scope.js");
    const rootDir = writeExternalPolicyFixture();
    const owner = externalPolicyOwner(rootDir);
    const cache = createPluginCache();
    const work = new AsyncWorkScope();
    const operation = withPluginCache(cache, () =>
      work.track(() => loadProviderPolicyArtifactsAsync([owner])),
    );
    const rejected = expect(operation).rejects.toThrow();
    work.beginClose();
    await rejected;
    expect(cache.setupModules.size).toBe(0);
    await work.drain();
    await retirePluginCache(cache);
  });

  it("retains a trusted installed provider owner without a policy artifact", () => {
    const pluginRoot = tempDirs.make("openclaw-provider-owner-");
    const plugin = {
      id: "llama-cpp",
      origin: "external",
      trustedOfficialInstall: true,
      rootDir: pluginRoot,
      providers: ["llama-cpp"],
      cliBackends: [],
      contracts: { embeddingProviders: ["local"] },
    } as never;
    const manifestRegistry = { plugins: [plugin] };

    const owners = listTrustedExternalProviderPolicyOwners("local", manifestRegistry);
    expect(loadProviderPolicyArtifacts(owners)).toEqual({
      owner: plugin,
      surface: null,
    });
    expect(resolveProviderPolicySurface("local", { manifestRegistry })).toBeNull();
  });

  it("continues to a usable policy when the first trusted owner lacks its artifact", () => {
    const missingPolicyRoot = tempDirs.make("openclaw-provider-owner-missing-");
    const policyRoot = writeExternalPolicyFixture();
    const owner = (id: string, rootDir: string) =>
      ({
        id,
        origin: "external",
        trustedOfficialInstall: true,
        rootDir,
        providers: [],
        cliBackends: [],
        contracts: { embeddingProviders: ["fixture-embedding"] },
      }) as never;
    const manifestRegistry = {
      plugins: [owner("a-missing-policy", missingPolicyRoot), owner("b-policy", policyRoot)],
    };

    const owners = listTrustedExternalProviderPolicyOwners("fixture-embedding", manifestRegistry);
    const artifacts = loadProviderPolicyArtifacts(owners);

    expect(artifacts?.owner.id).toBe("b-policy");
    expect(artifacts?.surface?.inspectEmbeddingProviderSetup).toBeTypeOf("function");
  });

  it.runIf(process.platform !== "win32")(
    "rejects trusted official provider policy artifacts hardlinked outside the installed root",
    () => {
      const tempRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-policy-hardlink-")),
      );
      const pluginRoot = path.join(tempRoot, "installed-provider");
      const outsidePath = path.join(tempRoot, "outside-policy.js");
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.writeFileSync(
        outsidePath,
        'export function resolveThinkingProfile() { return { defaultLevel: "escaped" }; }\n',
        "utf8",
      );
      fs.linkSync(outsidePath, path.join(pluginRoot, "provider-policy-api.js"));

      try {
        const pluginId = "hardlinked-provider";
        expect(() =>
          resolveProviderPolicySurface(pluginId, {
            manifestRegistry: {
              plugins: [
                {
                  id: pluginId,
                  origin: "global",
                  trustedOfficialInstall: true,
                  rootDir: pluginRoot,
                  providers: [pluginId],
                  cliBackends: [],
                } as never,
              ],
            },
          }),
        ).toThrow("Unable to open plugin public surface provider-policy-api.js");
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("resolves namespaced provider policies from their trusted external plugin root", () => {
    isolateBundledPlugins();
    const pluginRoot = writeExternalPolicyFixture();
    const fixturePlugin = externalPolicyOwner(pluginRoot, "fixture:nvidia");

    const surface = resolveProviderPolicySurface("fixture:nvidia", {
      manifestRegistry: { plugins: [fixturePlugin] },
    });

    expect(
      surface
        ?.resolveThinkingProfile?.({ provider: "fixture:nvidia", modelId: "full" })
        ?.levels.map((level) => level.id),
    ).toEqual(["off", "high", "max"]);
  });

  it.each([false, true])(
    "does not load public policy code from untrusted external plugins (configured=%s)",
    (configured) => {
      const pluginRoot = writeExternalPolicyFixture();
      expect(
        resolveProviderPolicySurface("fixture-provider", {
          config: configured ? { plugins: { allow: ["fixture-provider"] } } : undefined,
          manifestRegistry: {
            plugins: [
              {
                id: "fixture-provider",
                origin: "external",
                rootDir: pluginRoot,
                providers: ["fixture-provider"],
                cliBackends: [],
              } as never,
            ],
          },
        }),
      ).toBeNull();
    },
  );

  it.each([
    {
      owner: { id: "xai", providers: ["xai"], providerAuthAliases: { "x-ai": "xai" } },
      provider: "x-ai",
      modelId: "grok-4.5",
      resolveThinkingProfile: ({ provider, modelId }: { provider: string; modelId: string }) =>
        provider === "x-ai" && modelId === "grok-4.5"
          ? { levels: [{ id: "low" }, { id: "medium" }, { id: "high" }], defaultLevel: "high" }
          : { levels: [{ id: "off" }], defaultLevel: "off" },
      expected: { levels: [{ id: "low" }, { id: "medium" }, { id: "high" }], defaultLevel: "high" },
    },
    {
      owner: { id: "anthropic", providers: ["anthropic"], cliBackends: ["claude-cli"] },
      provider: "claude-cli",
      modelId: "claude-opus-4-8",
      resolveThinkingProfile: ({ provider }: { provider: string }) => ({
        levels: [{ id: provider }],
      }),
      expected: { levels: [{ id: "claude-cli" }] },
    },
    {
      owner: { id: "owner", providers: ["alias"] },
      provider: "alias",
      modelId: "demo",
      resolveThinkingProfile: () => ({ levels: [{ id: "owner" }] }),
      expected: { levels: [{ id: "owner" }] },
    },
  ])("resolves manifest-owned policy for $provider without scanning", async (test) => {
    const { owner, provider, modelId, resolveThinkingProfile, expected } = test;
    const { resolve, loadArtifact, scan } = await loadOwnedPolicyResolver(provider, owner.id, {
      resolveThinkingProfile,
    });
    const surface = resolve(provider, {
      manifestRegistry: { plugins: [createPluginManifestRecordFixture(owner)] },
    });
    expect(surface?.resolveThinkingProfile?.({ provider, modelId })).toEqual(expected);
    expect(loadArtifact).toHaveBeenCalledWith({
      dirName: owner.id,
      artifactCandidates: ["provider-policy-api.js"],
    });
    expect(scan).not.toHaveBeenCalled();
  });

  it("keeps manifest-owned provider policy aliases stable until a new operation", async () => {
    const bundledPluginsDir = tempDirs.make("openclaw-provider-policy-refresh-");
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

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    writePlugin("first", ["fixture-provider"], 1);
    writePlugin("second", [], 1);
    const resolvePolicySurface = await loadPolicyResolver(
      "provider-alias-refresh",
      ({ dirName }) =>
        dirName === "first" || dirName === "second"
          ? { resolveThinkingProfile: () => ({ levels: [{ id: dirName }] }) }
          : null,
    );

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

  it("keeps canonical provider policy lookup on the direct artifact path", async () => {
    const loadArtifact = vi.fn(() => ({
      normalizeConfig: (ctx: { providerConfig: ModelProviderConfig }) => ctx.providerConfig,
    }));
    const resolvePolicySurface = await loadPolicyResolver("no-runtime-deps", loadArtifact);

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
      kind: "indeterminate" as const,
    }));
    const loadArtifact = vi.fn(() => ({
      resolveModelRoutes,
    }));
    const resolvePolicySurface = await loadPolicyResolver("model-routes-only", loadArtifact);

    const surface = resolvePolicySurface("openai");
    expect(surface?.resolveModelRoutes?.({ provider: "openai" })).toEqual({
      kind: "indeterminate",
    });
  });
});
