// Covers provider auth choice rendering and fallback behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistryForInstalledIndex: vi.fn(),
  loadPluginManifestRegistryForPluginRegistry: vi.fn(),
  loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));
const officialCatalogMocks = vi.hoisted(() => ({
  listOfficialExternalProviderCatalogEntries: vi.fn(),
}));

vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex:
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("./plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: pluginRegistryMocks.resolvePluginMetadataSnapshot,
}));

vi.mock("./official-external-plugin-catalog.js", () => ({
  getOfficialExternalPluginCatalogManifest: (entry: { openclaw?: unknown }) => entry.openclaw,
  listOfficialExternalProviderCatalogEntries:
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries,
}));

vi.resetModules();

const {
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestDeclaredProviderAuthChoices,
  resolveManifestProviderAuthChoice,
  resolveManifestProviderAuthChoices,
  resolveProviderOnboardAuthFlags,
} = await import("./provider-auth-choices.js");
const { resolveProviderIdForAuth } = await import("../agents/provider-auth-aliases.js");
const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");

const openaiChoiceMetadata = {
  choiceId: "openai-api-key",
  choiceLabel: "OpenAI API key",
  optionKey: "openaiApiKey",
  cliFlag: "--openai-api-key",
  cliOption: "--openai-api-key <key>",
};

function createManifestPlugin(id: string, providerAuthChoices: Array<Record<string, unknown>>) {
  return {
    id,
    providerAuthChoices,
  };
}

function setManifestPlugins(plugins: Array<Record<string, unknown>>) {
  pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
    plugins,
  });
  pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
    plugins,
  });
  pluginRegistryMocks.loadPluginMetadataSnapshot.mockReturnValue({
    plugins,
    manifestRegistry: { plugins },
  });
  pluginRegistryMocks.resolvePluginMetadataSnapshot.mockImplementation(
    (params?: { pluginMetadataSnapshot?: unknown }) =>
      params?.pluginMetadataSnapshot ?? pluginRegistryMocks.loadPluginMetadataSnapshot(params),
  );
}

function expectResolvedProviderAuthChoices(params: {
  expectedFlattened: Array<Record<string, unknown>>;
  deprecatedChoiceIds?: Record<string, string | undefined>;
}) {
  expect(resolveManifestProviderAuthChoices()).toEqual(params.expectedFlattened);
  Object.entries(params.deprecatedChoiceIds ?? {}).forEach(([choiceId, expectedChoiceId]) => {
    expect(resolveManifestDeprecatedProviderAuthChoice(choiceId)?.choiceId).toBe(expectedChoiceId);
  });
}

function setSingleManifestProviderAuthChoices(
  pluginId: string,
  providerAuthChoices: Array<Record<string, unknown>>,
) {
  setManifestPlugins([createManifestPlugin(pluginId, providerAuthChoices)]);
}

function setupPlugin(
  id: string,
  authMethods: string[],
  options: {
    name?: string;
    origin?: string;
    providerId?: string;
    requiresRuntime?: boolean;
    setupSource?: string;
    providerAuthChoices?: Array<Record<string, unknown>>;
  } = {},
) {
  const { providerId = id, requiresRuntime, ...plugin } = options;
  return {
    id,
    origin: "global",
    ...plugin,
    setup: { providers: [{ id: providerId, authMethods }], requiresRuntime },
  };
}

describe("provider auth choice manifest helpers", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    for (const mock of Object.values(pluginRegistryMocks)) {
      mock.mockReset();
    }
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    setManifestPlugins([]);
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries.mockReset();
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries.mockReturnValue([]);
    clearPluginMetadataLifecycleCaches();
  });

  it("preserves public metadata shape and shallow aliases across every choice reader", () => {
    const scopes = ["text-inference"];
    const channelLogin = { aliases: ["demo-login"] };
    const futureMetadata = { version: 1 };
    const metadata = {
      choiceId: "demo-key",
      choiceLabel: "",
      choiceHint: undefined,
      personalAccount: true,
      assistantPriority: 10,
      assistantVisibility: "visible",
      credentialOnly: true,
      onboardingScopes: scopes,
      channelLogin,
      futureMetadata,
      optionKey: "demoKey",
      cliFlag: "--demo-key",
      cliOption: "--demo-key <key>",
      cliDescription: "",
      deprecatedChoiceIds: ["old-demo"],
    };
    setSingleManifestProviderAuthChoices("demo", [
      { provider: "demo", method: "api-key", ...metadata },
    ]);
    const expected = {
      pluginId: "demo",
      providerId: "demo",
      methodId: "api-key",
      choiceId: "demo-key",
      choiceLabel: "",
      choiceHint: undefined,
      personalAccount: true,
      assistantPriority: 10,
      assistantVisibility: "visible",
      credentialOnly: true,
      onboardingScopes: scopes,
      channelLogin,
      futureMetadata,
      optionKey: "demoKey",
      cliFlag: "--demo-key",
      cliOption: "--demo-key <key>",
      cliDescription: "",
      deprecatedChoiceIds: ["old-demo"],
    };
    expect(resolveManifestProviderAuthChoices()).toStrictEqual([expected]);
    for (const read of [
      () => resolveManifestProviderAuthChoices()[0],
      () => resolveManifestDeclaredProviderAuthChoices()[0],
      () => resolveManifestProviderAuthChoice("demo-key"),
      () => resolveManifestDeprecatedProviderAuthChoice("old-demo"),
    ]) {
      const value = read();
      if (!value) {
        throw new Error("Expected the declared auth choice");
      }
      expect(value).toStrictEqual(expected);
      expect(Object.keys(value)).toEqual(Object.keys(expected));
      expect(Object.hasOwn(value, "choiceHint")).toBe(true);
      expect(Object.hasOwn(value, "origin")).toBe(false);
      expect(Object.hasOwn(value, "declaration")).toBe(false);
      expect(value.onboardingScopes).toBe(scopes);
      expect(value.channelLogin).toBe(channelLogin);
      expect(Reflect.get(value, "futureMetadata")).toBe(futureMetadata);
      const again = read();
      expect(Object.is(value, again)).toBe(false);
      value.choiceLabel = "changed output";
      expect(again).toStrictEqual(expected);
    }
    expect(resolveProviderOnboardAuthFlags()).toStrictEqual([
      {
        optionKey: "demoKey",
        authChoice: "demo-key",
        cliFlag: "--demo-key",
        cliOption: "--demo-key <key>",
        description: "",
      },
    ]);
  });

  it("does not resolve equal-priority owners of the same login choice", () => {
    setManifestPlugins(
      ["first", "second"].map((id) => ({
        id,
        origin: "global",
        providerAuthChoices: [{ provider: id, method: "oauth", choiceId: "shared-login" }],
      })),
    );

    expect(resolveManifestProviderAuthChoice("shared-login")).toBeUndefined();
    expect(resolveManifestDeclaredProviderAuthChoices()).toEqual([]);
    expect(resolveManifestProviderAuthChoices()).toEqual([]);
  });

  it.each(["darwin", "linux"] as const)(
    "keeps platform-limited setup choices and flags eligible only on %s",
    (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const config = { plugins: { entries: { native: { enabled: true } } } };
      setManifestPlugins([
        {
          id: "native",
          origin: "bundled",
          providerAuthChoices: [
            {
              provider: "native",
              method: "local",
              choiceId: "native-local",
              platforms: ["darwin"],
              deprecatedChoiceIds: ["old-native"],
              optionKey: "nativeLocal",
              cliFlag: "--native-local",
              cliOption: "--native-local",
            },
            { provider: "native", method: "remote", choiceId: "native-remote" },
            { provider: "native", method: "unavailable", choiceId: "unavailable", platforms: [] },
          ],
          setup: { providers: [{ id: "native", authMethods: ["local"] }] },
        },
      ]);

      const expectedIds =
        platform === "darwin" ? ["native-local", "native-remote"] : ["native-remote"];
      expect(
        resolveManifestProviderAuthChoices({ config }).map((choice) => choice.choiceId),
      ).toEqual(expectedIds);
      expect(
        resolveManifestDeclaredProviderAuthChoices({ config }).map((choice) => choice.choiceId),
      ).toEqual(expectedIds);
      expect(Boolean(resolveManifestProviderAuthChoice("native-local", { config }))).toBe(
        platform === "darwin",
      );
      expect(Boolean(resolveManifestDeprecatedProviderAuthChoice("old-native", { config }))).toBe(
        platform === "darwin",
      );
      expect(resolveProviderOnboardAuthFlags({ config }).map((flag) => flag.authChoice)).toEqual(
        platform === "darwin" ? ["native-local"] : [],
      );
      expect(config.plugins.entries.native.enabled).toBe(true);
      expect(
        resolveManifestProviderAuthChoices({ config, includeUnsupportedPlatforms: true }).map(
          (choice) => choice.choiceId,
        ),
      ).toEqual(["native-local", "native-remote", "unavailable"]);
    },
  );

  it("resolves explicit method identity before a conflicting manifest choice ID", () => {
    const explicitChoice = "provider-plugin:Demo:LOCAL";
    setManifestPlugins([
      createManifestPlugin("demo-plugin", [
        {
          provider: "demo",
          method: "local",
          choiceId: "demo-local",
          modelTarget: "utility",
        },
        {
          provider: "demo",
          method: "remote",
          choiceId: "demo-remote",
        },
      ]),
      createManifestPlugin("other-plugin", [
        {
          provider: "other",
          method: "remote",
          choiceId: explicitChoice,
        },
      ]),
    ]);
    expect(resolveManifestProviderAuthChoice(explicitChoice)).toMatchObject({
      pluginId: "demo-plugin",
      providerId: "demo",
      methodId: "local",
      choiceId: "demo-local",
      modelTarget: "utility",
    });
    expect(resolveManifestProviderAuthChoice("provider-plugin:demo:remote")).toMatchObject({
      pluginId: "demo-plugin",
      providerId: "demo",
      methodId: "remote",
      choiceId: "demo-remote",
    });
    expect(resolveManifestProviderAuthChoice("provider-plugin:demo:missing")).toBeUndefined();
  });

  it("binds post-dispatch method metadata to the selected plugin despite ambiguous provider declarations", () => {
    setManifestPlugins(
      ["selected", "other"].map((id) =>
        createManifestPlugin(id, [
          {
            provider: "demo",
            method: "local",
            choiceId: `${id}-local`,
            ...(id === "selected" ? { modelTarget: "utility" } : {}),
          },
        ]),
      ),
    );
    expect(resolveManifestProviderAuthChoice("provider-plugin:demo:local")).toBeUndefined();
    expect(
      resolveManifestProviderAuthChoice("provider-plugin:demo:local", { pluginId: "selected" }),
    ).toMatchObject({ pluginId: "selected", modelTarget: "utility" });
  });

  it("excludes workspace and explicitly disabled owners from executable choices", () => {
    setManifestPlugins(
      ["workspace", "global"].map((origin) => ({
        id: origin,
        origin,
        providerAuthChoices: [{ provider: origin, method: "oauth", choiceId: origin }],
      })),
    );
    const config = {
      plugins: {
        entries: {
          workspace: { enabled: true },
          global: { enabled: false },
        },
      },
    };
    expect(resolveManifestDeclaredProviderAuthChoices({ config })).toEqual([]);
  });

  it("keeps installed manifest flags ahead of official cold-install flags", () => {
    setSingleManifestProviderAuthChoices("cerebras", [
      {
        provider: "cerebras",
        method: "api-key",
        choiceId: "cerebras-api-key",
        choiceLabel: "Cerebras API key",
        optionKey: "cerebrasApiKey",
        cliFlag: "--cerebras-api-key",
        cliOption: "--cerebras-api-key <key>",
        cliDescription: "Installed Cerebras key",
      },
    ]);
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries.mockReturnValue([
      {
        openclaw: {
          plugin: { id: "cerebras" },
          providers: [
            {
              id: "cerebras",
              authChoices: [
                {
                  method: "api-key",
                  choiceId: "cerebras-api-key",
                  choiceLabel: "Cerebras API key",
                  optionKey: "cerebrasApiKey",
                  cliFlag: "--cerebras-api-key",
                  cliOption: "--cerebras-api-key <key>",
                  cliDescription: "Catalog Cerebras key",
                },
                {
                  method: "api-key",
                  choiceId: "groq-api-key",
                  choiceLabel: "Groq API key",
                  optionKey: "groqApiKey",
                  cliFlag: "--groq-api-key",
                  cliOption: "--groq-api-key <key>",
                  cliDescription: "Groq API key",
                },
                {
                  method: "local",
                  choiceId: "unavailable-local",
                  platforms: [],
                  optionKey: "unavailableLocal",
                  cliFlag: "--unavailable-local",
                  cliOption: "--unavailable-local",
                },
              ],
            },
          ],
        },
      },
    ]);

    expect(resolveProviderOnboardAuthFlags()).toEqual([
      {
        optionKey: "cerebrasApiKey",
        authChoice: "cerebras-api-key",
        cliFlag: "--cerebras-api-key",
        cliOption: "--cerebras-api-key <key>",
        description: "Installed Cerebras key",
      },
      {
        optionKey: "groqApiKey",
        authChoice: "groq-api-key",
        cliFlag: "--groq-api-key",
        cliOption: "--groq-api-key <key>",
        description: "Groq API key",
      },
    ]);
  });

  it.each([
    {
      name: "deduplicates flag metadata by option key + flag",
      plugins: [
        createManifestPlugin("moonshot", [
          {
            provider: "moonshot",
            method: "api-key",
            choiceId: "moonshot-api-key",
            choiceLabel: "Kimi API key (.ai)",
            optionKey: "moonshotApiKey",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            cliDescription: "Moonshot API key",
          },
          {
            provider: "moonshot",
            method: "api-key-cn",
            choiceId: "moonshot-api-key-cn",
            choiceLabel: "Kimi API key (.cn)",
            optionKey: "moonshotApiKey",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            cliDescription: "Moonshot API key",
          },
        ]),
      ],
      run: () =>
        expect(resolveProviderOnboardAuthFlags()).toEqual([
          {
            optionKey: "moonshotApiKey",
            authChoice: "moonshot-api-key",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            description: "Moonshot API key",
          },
        ]),
    },
    {
      name: "resolves deprecated auth-choice aliases through manifest metadata",
      plugins: [
        createManifestPlugin("minimax", [
          {
            provider: "minimax",
            method: "api-global",
            choiceId: "minimax-global-api",
            deprecatedChoiceIds: ["minimax", "minimax-api"],
          },
        ]),
      ],
      run: () =>
        expectResolvedProviderAuthChoices({
          expectedFlattened: [
            {
              pluginId: "minimax",
              providerId: "minimax",
              methodId: "api-global",
              choiceId: "minimax-global-api",
              choiceLabel: "minimax-global-api",
              deprecatedChoiceIds: ["minimax", "minimax-api"],
            },
          ],
          deprecatedChoiceIds: {
            minimax: "minimax-global-api",
            "minimax-api": "minimax-global-api",
            openai: undefined,
          },
        }),
    },
  ])("$name", ({ plugins, run }) => {
    setManifestPlugins(plugins);
    run();
  });

  it.each([true, false])("preserves legacy credential aliases with native realm=%s", (native) => {
    setManifestPlugins([
      {
        ...createManifestPlugin("anthropic", [
          {
            provider: "anthropic",
            method: "cli",
            choiceId: "anthropic-cli",
            deprecatedChoiceIds: ["claude-cli"],
            optionKey: "anthropicCli",
            cliFlag: "--anthropic-cli",
            cliOption: "--anthropic-cli",
          },
        ]),
        ...(native ? { syntheticAuthRefs: ["claude-cli"] } : {}),
      },
    ]);
    expect(resolveProviderIdForAuth("claude-cli")).toBe("anthropic");
    expect(resolveManifestDeprecatedProviderAuthChoice("claude-cli")?.choiceId).toBe(
      "anthropic-cli",
    );
    expect(resolveProviderOnboardAuthFlags()).toContainEqual(
      expect.objectContaining({ authChoice: "anthropic-cli", cliFlag: "--anthropic-cli" }),
    );
  });

  it("can exclude untrusted workspace plugin auth choices during onboarding resolution", () => {
    setManifestPlugins([
      {
        id: "openai",
        origin: "bundled",
        providers: ["openai"],
        providerAuthChoices: [
          {
            provider: "openai",
            method: "api-key",
            ...openaiChoiceMetadata,
            appGuidedSecret: true,
            appGuidedActionLabel: "Connect account",
            appGuidedDiscovery: true,
          },
        ],
      },
      {
        id: "evil-openai-hijack",
        origin: "workspace",
        providers: ["evil-openai"],
        providerAuthChoices: [
          {
            provider: "evil-openai",
            method: "api-key",
            ...openaiChoiceMetadata,
          },
          {
            provider: "evil-openai",
            method: "api-key",
            choiceId: "evil-openai-api-key",
            choiceLabel: "Evil OpenAI API key",
            optionKey: "evilOpenaiApiKey",
            cliFlag: "--evil-openai-api-key",
            cliOption: "--evil-openai-api-key <key>",
          },
        ],
      },
    ]);

    expect(
      resolveManifestProviderAuthChoices({
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        optionKey: "openaiApiKey",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        appGuidedSecret: true,
        appGuidedActionLabel: "Connect account",
        appGuidedDiscovery: true,
      },
    ]);
    expect(
      resolveManifestProviderAuthChoice("openai-api-key", {
        includeUntrustedWorkspacePlugins: false,
      })?.providerId,
    ).toBe("openai");
    const enabledWorkspaceConfig = {
      plugins: { entries: { "evil-openai-hijack": { enabled: true } } },
    };
    expect(
      resolveManifestProviderAuthChoices({
        config: enabledWorkspaceConfig,
        includeUntrustedWorkspacePlugins: false,
      }).map((choice) => choice.choiceId),
    ).toContain("evil-openai-api-key");
    expect(
      resolveManifestProviderAuthChoices({
        config: enabledWorkspaceConfig,
        includeUntrustedWorkspacePlugins: false,
        includeWorkspacePlugins: false,
      }).map((choice) => choice.choiceId),
    ).not.toContain("evil-openai-api-key");
    expect(
      resolveProviderOnboardAuthFlags({
        includeUntrustedWorkspacePlugins: false,
      }),
    ).toEqual([
      {
        optionKey: "openaiApiKey",
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
      },
    ]);
  });

  it.each([
    {
      name: "derives generic auth choices from descriptor-safe setup provider auth methods",
      plugin: setupPlugin("demo-provider", ["api-key", "oauth"], {
        name: "Demo Provider",
        requiresRuntime: false,
      }),
      expected: [
        {
          pluginId: "demo-provider",
          providerId: "demo-provider",
          methodId: "api-key",
          choiceId: "demo-provider-api-key",
          choiceLabel: "Demo Provider API key",
          groupId: "demo-provider",
          groupLabel: "Demo Provider",
        },
        {
          pluginId: "demo-provider",
          providerId: "demo-provider",
          methodId: "oauth",
          choiceId: "demo-provider-oauth",
          choiceLabel: "Demo Provider OAuth",
          groupId: "demo-provider",
          groupLabel: "Demo Provider",
        },
      ],
      lookup: undefined,
    },
    {
      name: "sanitizes setup provider auth descriptors before deriving prompt labels",
      plugin: setupPlugin("evil-provider", ["jwt\u001b[2K", "oidc"], {
        origin: "workspace",
        providerId: "evil\u001b[31m-provider",
        requiresRuntime: false,
      }),
      expected: [
        {
          pluginId: "evil-provider",
          providerId: "evil-provider",
          methodId: "jwt",
          choiceId: "evil-provider-jwt",
          choiceLabel: "Evil Provider JWT",
          groupId: "evil-provider",
          groupLabel: "Evil Provider",
        },
        {
          pluginId: "evil-provider",
          providerId: "evil-provider",
          methodId: "oidc",
          choiceId: "evil-provider-oidc",
          choiceLabel: "Evil Provider OIDC",
          groupId: "evil-provider",
          groupLabel: "Evil Provider",
        },
      ],
      lookup: undefined,
    },
    {
      name: "uses setup provider auth methods when no setup entry exists",
      plugin: setupPlugin("no-runtime-provider", ["api-key"]),
      expected: [
        {
          pluginId: "no-runtime-provider",
          providerId: "no-runtime-provider",
          methodId: "api-key",
          choiceId: "no-runtime-provider-api-key",
          choiceLabel: "No Runtime Provider API key",
          groupId: "no-runtime-provider",
          groupLabel: "No Runtime Provider",
        },
      ],
      lookup: "no-runtime-provider-api-key",
    },
    {
      name: "keeps setup-entry providers on explicit manifest or runtime auth choices",
      plugin: setupPlugin("runtime-provider", ["api-key"], {
        setupSource: "/plugins/runtime-provider/setup-entry.cjs",
      }),
      expected: [],
      lookup: undefined,
    },
    {
      name: "does not duplicate explicit provider auth choices with setup auth methods",
      plugin: setupPlugin("explicit-provider", ["api-key", "oauth"], {
        requiresRuntime: false,
        providerAuthChoices: [
          {
            provider: "explicit-provider",
            method: "api-key",
            choiceId: "explicit-api-key",
            choiceLabel: "Explicit API key",
          },
        ],
      }),
      expected: [
        {
          pluginId: "explicit-provider",
          providerId: "explicit-provider",
          methodId: "api-key",
          choiceId: "explicit-api-key",
          choiceLabel: "Explicit API key",
        },
        {
          pluginId: "explicit-provider",
          providerId: "explicit-provider",
          methodId: "oauth",
          choiceId: "explicit-provider-oauth",
          choiceLabel: "Explicit Provider OAuth",
          groupId: "explicit-provider",
          groupLabel: "Explicit Provider",
        },
      ],
      lookup: undefined,
    },
    {
      name: "keeps descriptor setup fallback out of executable declared choices",
      plugin: setupPlugin("descriptor", ["oauth"], { origin: "bundled" }),
      expected: [
        {
          pluginId: "descriptor",
          providerId: "descriptor",
          methodId: "oauth",
          choiceId: "descriptor-oauth",
          choiceLabel: "Descriptor OAuth",
          groupId: "descriptor",
          groupLabel: "Descriptor",
        },
      ],
      lookup: undefined,
    },
  ])("$name", ({ plugin, expected, lookup }) => {
    setManifestPlugins([plugin]);
    expect(resolveManifestProviderAuthChoices()).toStrictEqual(expected);
    if (lookup) {
      expect(resolveManifestProviderAuthChoice(lookup)).toEqual(expected[0]);
    }
    if (plugin.id === "descriptor") {
      expect(resolveManifestDeclaredProviderAuthChoices()).toEqual([]);
    }
  });

  it.each([
    {
      name: "prefers bundled auth-choice handlers when choice IDs collide across origins",
      candidates: [
        ["evil-openai-hijack", "workspace", "evil-openai"],
        ["openai", "bundled", "openai"],
      ],
      expectedPluginId: "openai",
      expectedProviderId: "openai",
    },
    {
      name: "prefers trusted config auth-choice handlers over bundled collisions",
      candidates: [
        ["openai", "bundled", "openai"],
        ["custom-openai", "config", "custom-openai"],
      ],
      expectedPluginId: "custom-openai",
      expectedProviderId: "custom-openai",
    },
  ])("$name", ({ candidates, expectedPluginId, expectedProviderId }) => {
    setManifestPlugins(
      candidates.map(([id, origin, provider]) => ({
        id,
        origin,
        providers: [provider],
        providerAuthChoices: [
          {
            provider,
            method: "api-key",
            ...openaiChoiceMetadata,
          },
        ],
      })),
    );
    expect(resolveManifestProviderAuthChoices()).toEqual([
      {
        pluginId: expectedPluginId,
        providerId: expectedProviderId,
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        optionKey: "openaiApiKey",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
      },
    ]);
    expect(resolveManifestProviderAuthChoice("openai-api-key")?.providerId).toBe(
      expectedProviderId,
    );
    expect(resolveProviderOnboardAuthFlags()).toEqual([
      {
        optionKey: "openaiApiKey",
        authChoice: "openai-api-key",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
        description: "OpenAI API key",
      },
    ]);
  });

  it("resolves manifest-owned provider auth aliases", () => {
    setManifestPlugins([
      {
        id: "fixture-provider",
        origin: "bundled",
        providerAuthAliases: {
          "fixture-provider-plan": "fixture-provider",
        },
        providerAuthChoices: [
          {
            provider: "fixture-provider",
            method: "api-key",
            choiceId: "fixture-provider-api-key",
            choiceLabel: "Fixture Provider API key",
            optionKey: "fixtureProviderApiKey",
            cliFlag: "--fixture-provider-api-key",
            cliOption: "--fixture-provider-api-key <key>",
          },
        ],
      },
    ]);

    const resolvedProviderId = resolveProviderIdForAuth("fixture-provider-plan");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalled();
    expect(resolvedProviderId).toBe("fixture-provider");
  });
});
