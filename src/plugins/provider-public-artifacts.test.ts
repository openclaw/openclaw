// Verifies provider public artifacts extracted from plugin metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "./plugin-metadata.test-support.js";
import { bindPluginInstanceModuleLoader } from "./plugin-module-loader-cache.js";
import { resolveDirectBundledProviderPolicySurface } from "./provider-policy-surface.js";
import {
  listTrustedExternalProviderPolicyOwners,
  loadTrustedExternalProviderPolicyArtifacts,
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
  const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-policy-external-"));
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

describe("provider public artifacts", () => {
  const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  const originalTrustBundledPluginsDir = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

  function restoreBundledPluginEnv() {
    if (originalBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
    }
    if (originalTrustBundledPluginsDir === undefined) {
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    } else {
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrustBundledPluginsDir;
    }
  }

  beforeEach(() => {
    vi.resetModules();
    clearPluginMetadataLifecycleCaches();
  });

  afterEach(() => {
    restoreBundledPluginEnv();
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
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
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

  it("loads MiniMax thinking policy before runtime registration", () => {
    const surface = resolveBundledProviderPolicySurface("minimax");

    expect(
      surface?.resolveThinkingProfile?.({ provider: "minimax", modelId: "MiniMax-M2.7" })
        ?.defaultLevel,
    ).toBe("off");
    expect(
      surface?.resolveThinkingProfile?.({ provider: "minimax", modelId: "MiniMax-M3" })
        ?.defaultLevel,
    ).toBe("adaptive");
  });

  it("loads Moonshot always-thinking policies before runtime registration", () => {
    const surface = resolveBundledProviderPolicySurface("moonshot");

    expect(
      surface?.resolveThinkingProfile?.({
        provider: "moonshot",
        modelId: "kimi-k2.7-code",
      }),
    ).toEqual({
      levels: [{ id: "low", label: "on" }],
      defaultLevel: "low",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(
      surface?.resolveThinkingProfile?.({
        provider: "moonshot",
        modelId: "kimi-k3",
      }),
    ).toEqual({
      levels: [{ id: "max", label: "max" }],
      defaultLevel: "max",
      preserveWhenCatalogReasoningFalse: true,
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
        [["max", "high", "low", "high", "none"], ["off", "max", "high", "low"], "high"],
        [
          ["high", "medium", "low", "minimal", "xhigh"],
          ["off", "high", "medium", "low", "minimal", "xhigh"],
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
      ["deepseek-v4-pro", ["off", "high", "max"], "high"],
      ["kimi-k3", ["off", "max"], "off"],
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
    const bundledPluginsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-empty-bundled-plugins-"),
    );
    const pluginRoot = writeExternalPolicyFixture();

    try {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
      const fixturePlugin = {
        id: "fixture-provider",
        origin: "external",
        trustedOfficialInstall: true,
        rootDir: pluginRoot,
        providers: ["fixture-provider"],
        cliBackends: [],
        contracts: { embeddingProviders: ["fixture-embedding"] },
      } as const;
      const surface = resolveProviderPolicySurface("fixture-provider", {
        manifestRegistry: { plugins: [fixturePlugin as never] },
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
      expect(surface).not.toHaveProperty("projectConfiguredModelRow");
      expect(
        resolveProviderPolicySurface("fixture-embedding", {
          manifestRegistry: { plugins: [fixturePlugin as never] },
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
    } finally {
      restoreBundledPluginEnv();
      fs.rmSync(pluginRoot, { recursive: true, force: true });
      fs.rmSync(bundledPluginsDir, { recursive: true, force: true });
    }
  });

  it.each(["untrusted", "cold", "loaded", "catalog", "evaluation-error"] as const)(
    "keeps trusted external policy under its admitted owner (%s)",
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
        origin: "global",
        trustedOfficialInstall: scenario !== "untrusted",
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
            withPluginCache(cache, () => loadTrustedExternalProviderPolicyArtifacts([metadata])),
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
          const policySurface = resolve()?.surface;
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
    expect(loadTrustedExternalProviderPolicyArtifacts(owners)).toEqual({
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
    try {
      const manifestRegistry = {
        plugins: [owner("a-missing-policy", missingPolicyRoot), owner("b-policy", policyRoot)],
      };

      const owners = listTrustedExternalProviderPolicyOwners("fixture-embedding", manifestRegistry);
      const artifacts = loadTrustedExternalProviderPolicyArtifacts(owners);

      expect(artifacts?.owner.id).toBe("b-policy");
      expect(artifacts?.surface?.inspectEmbeddingProviderSetup).toBeTypeOf("function");
    } finally {
      fs.rmSync(policyRoot, { recursive: true, force: true });
    }
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
    const bundledPluginsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-empty-bundled-plugins-"),
    );
    const pluginRoot = writeExternalPolicyFixture();

    try {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
      const fixturePlugin = {
        id: "fixture-provider",
        origin: "external",
        trustedOfficialInstall: true,
        rootDir: pluginRoot,
        providers: ["fixture:nvidia"],
        cliBackends: [],
      } as const;

      const surface = resolveProviderPolicySurface("fixture:nvidia", {
        manifestRegistry: { plugins: [fixturePlugin as never] },
      });

      expect(
        surface
          ?.resolveThinkingProfile?.({ provider: "fixture:nvidia", modelId: "full" })
          ?.levels.map((level) => level.id),
      ).toEqual(["off", "high", "max"]);
    } finally {
      restoreBundledPluginEnv();
      fs.rmSync(pluginRoot, { recursive: true, force: true });
      fs.rmSync(bundledPluginsDir, { recursive: true, force: true });
    }
  });

  it("does not load public policy code from untrusted external plugins", () => {
    const pluginRoot = writeExternalPolicyFixture();
    try {
      expect(
        resolveProviderPolicySurface("fixture-provider", {
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
    } finally {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
    }
  });

  it("resolves multi-provider policy artifacts by manifest-owned provider id", async () => {
    const bundledPluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-provider-policy-"));
    const pluginDir = path.join(bundledPluginsDir, "openai");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "openai",
        configSchema: { type: "object" },
        providers: ["openai", "openai"],
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      "export default { register() {} };\n",
      "utf8",
    );

    const resolveThinkingProfile = vi.fn(({ modelId }: { modelId: string }) => ({
      levels: modelId === "gpt-5.5" ? [{ id: "xhigh" }] : [{ id: "low" }],
    }));
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(
      ({ dirName }: { dirName: string }) => {
        if (dirName !== "openai") {
          return null;
        }
        return { resolveThinkingProfile };
      },
    );

    vi.doMock("./bundled-dir.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./bundled-dir.js")>();
      return {
        ...actual,
        resolveBundledPluginsDir: () => bundledPluginsDir,
      };
    });
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    try {
      const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
        typeof import("./provider-public-artifacts.js")
      >(import.meta.url, "./provider-public-artifacts.js?scope=provider-alias");

      const surface = resolvePolicySurface("openai");

      expect(surface?.resolveThinkingProfile).toBeTypeOf("function");
      expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledWith({
        dirName: "openai",
        artifactCandidates: ["provider-policy-api.js"],
      });
      expect(
        surface
          ?.resolveThinkingProfile?.({
            provider: "openai",
            modelId: "gpt-5.5",
          })
          ?.levels.map((level) => level.id),
      ).toContain("xhigh");
      expect(
        surface
          ?.resolveThinkingProfile?.({
            provider: "openai",
            modelId: "gpt-4.1",
          })
          ?.levels.map((level) => level.id),
      ).not.toContain("xhigh");
    } finally {
      fs.rmSync(bundledPluginsDir, { force: true, recursive: true });
    }
  });

  it("resolves bundled policy artifacts through provider auth aliases", async () => {
    const loadPluginManifestRegistry = vi.fn(() => {
      throw new Error("unexpected manifest registry scan");
    });
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

    vi.doMock("./manifest-registry.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./manifest-registry.js")>();
      return {
        ...actual,
        loadPluginManifestRegistryCore: loadPluginManifestRegistry,
      };
    });
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
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(
      ({ dirName }: { dirName: string }) => {
        if (dirName !== "anthropic") {
          return null;
        }
        return {
          resolveThinkingProfile: ({ provider }: { provider: string }) => ({
            levels: [{ id: provider }],
          }),
        };
      },
    );

    vi.doMock("./manifest-registry.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./manifest-registry.js")>();
      return {
        ...actual,
        loadPluginManifestRegistryCore: loadPluginManifestRegistry,
      };
    });
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=provider-cli-backend");

    // CLI backend ids use the same provider-policy owner boundary as provider ids.
    // Without it, claude-cli subagents fall back to the base thinking profile.
    const surface = resolvePolicySurface("claude-cli", {
      manifestRegistry: {
        plugins: [
          {
            id: "anthropic",
            channels: [],
            cliBackends: ["claude-cli"],
            hooks: [],
            origin: "bundled",
            manifestPath: "/tmp/anthropic/openclaw.plugin.json",
            providers: ["anthropic"],
            rootDir: "/tmp/anthropic",
            skills: [],
            source: "/tmp/anthropic/index.js",
          },
        ],
      },
    });

    expect(
      surface?.resolveThinkingProfile?.({ provider: "claude-cli", modelId: "claude-opus-4-8" }),
    ).toEqual({
      levels: [{ id: "claude-cli" }],
    });
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledWith({
      dirName: "anthropic",
      artifactCandidates: ["provider-policy-api.js"],
    });
    expect(loadPluginManifestRegistry).not.toHaveBeenCalled();
  });

  it("keeps manifest-owned provider policy aliases stable until a new operation", async () => {
    const bundledPluginsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-provider-policy-refresh-"),
    );
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

    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(
      ({ dirName }: { dirName: string }) => {
        if (dirName !== "first" && dirName !== "second") {
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
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";

    try {
      writePlugin("first", ["fixture-provider"], 1);
      writePlugin("second", [], 1);
      const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
        typeof import("./provider-public-artifacts.js")
      >(import.meta.url, "./provider-public-artifacts.js?scope=provider-alias-refresh");

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
    } finally {
      fs.rmSync(bundledPluginsDir, { force: true, recursive: true });
    }
  });

  it("uses caller-provided manifest metadata for provider policy aliases", async () => {
    const loadPluginManifestRegistry = vi.fn(() => {
      throw new Error("unexpected manifest registry scan");
    });
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

    vi.doMock("./manifest-registry.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./manifest-registry.js")>();
      return {
        ...actual,
        loadPluginManifestRegistryCore: loadPluginManifestRegistry,
      };
    });
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
    const loadBundledPluginPublicArtifactModuleFromCandidatesSync = vi.fn(() => ({
      normalizeConfig: (ctx: { providerConfig: ModelProviderConfig }) => ctx.providerConfig,
    }));
    vi.doMock("./public-surface-loader.js", () => ({
      loadBundledPluginPublicArtifactModuleFromCandidatesSync,
    }));

    const { resolveBundledProviderPolicySurface: resolvePolicySurface } = await importFreshModule<
      typeof import("./provider-public-artifacts.js")
    >(import.meta.url, "./provider-public-artifacts.js?scope=no-runtime-deps");

    const manifestRegistry = {
      get plugins(): never {
        throw new Error("direct provider policy lookup must not inspect manifest metadata");
      },
    };
    const surface = resolvePolicySurface("openai", { manifestRegistry });
    expect(surface?.normalizeConfig).toBeTypeOf("function");
    expect(loadBundledPluginPublicArtifactModuleFromCandidatesSync).toHaveBeenCalledWith({
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
