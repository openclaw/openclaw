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
  resolveManifestDeprecatedProviderAuthChoice: deprecatedChoice,
  resolveManifestDeclaredProviderAuthChoices: declaredChoices,
  resolveManifestProviderAuthChoice: resolveChoice,
  resolveManifestProviderAuthChoices: resolveChoices,
  resolveProviderOnboardAuthFlags: authFlags,
} = await import("./provider-auth-choices.js");
const { resolveProviderIdForAuth } = await import("../agents/provider-auth-aliases.js");
const { clearPluginMetadataLifecycleCaches } = await import("./plugin-metadata-lifecycle.js");

const openaiChoiceMetadata = choiceMetadata("openai", "OpenAI");

function authMethod(provider: string, method: string, metadata: Record<string, unknown> = {}) {
  return { provider, method, choiceId: `${provider}-${method}`, ...metadata };
}

function choiceMetadata(provider: string, label: string) {
  return {
    choiceId: `${provider}-api-key`,
    choiceLabel: `${label} API key`,
    optionKey: `${provider}ApiKey`,
    cliFlag: `--${provider}-api-key`,
    cliOption: `--${provider}-api-key <key>`,
  };
}

function keyChoice(provider: string, label: string, overrides: Record<string, unknown> = {}) {
  return {
    ...authMethod(provider, "api-key"),
    ...choiceMetadata(provider, label),
    cliDescription: `${label} API key`,
    ...overrides,
  };
}

function expectedFlag(provider: string, description: string) {
  return {
    optionKey: `${provider}ApiKey`,
    authChoice: `${provider}-api-key`,
    cliFlag: `--${provider}-api-key`,
    cliOption: `--${provider}-api-key <key>`,
    description,
  };
}

function expectedSetupChoice(
  provider: string,
  method: string,
  groupLabel: string,
  methodLabel: string,
) {
  return {
    pluginId: provider,
    providerId: provider,
    methodId: method,
    choiceId: `${provider}-${method}`,
    choiceLabel: `${groupLabel} ${methodLabel}`,
    groupId: provider,
    groupLabel,
  };
}

function manifest(id: string, providerAuthChoices: Array<Record<string, unknown>>) {
  return { id, providerAuthChoices };
}

function loginPlugin(
  id: string,
  origin: string,
  provider: string,
  metadata: Record<string, unknown> = {},
  extras: Array<Record<string, unknown>> = [],
) {
  return {
    id,
    origin,
    providers: [provider],
    providerAuthChoices: [
      { provider, method: "api-key", ...openaiChoiceMetadata, ...metadata },
      ...extras,
    ],
  };
}

function setPlugins(plugins: Array<Record<string, unknown>>) {
  pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({ plugins });
  pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({ plugins });
  pluginRegistryMocks.loadPluginMetadataSnapshot.mockReturnValue({
    plugins,
    manifestRegistry: { plugins },
  });
  pluginRegistryMocks.resolvePluginMetadataSnapshot.mockImplementation(
    (params?: { pluginMetadataSnapshot?: unknown }) =>
      params?.pluginMetadataSnapshot ?? pluginRegistryMocks.loadPluginMetadataSnapshot(params),
  );
}

function setChoices(pluginId: string, providerAuthChoices: Array<Record<string, unknown>>) {
  setPlugins([manifest(pluginId, providerAuthChoices)]);
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
    setPlugins([]);
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
    setChoices("demo", [{ provider: "demo", method: "api-key", ...metadata }]);
    const expected = {
      pluginId: "demo",
      providerId: "demo",
      methodId: "api-key",
      ...metadata,
    };
    expect(resolveChoices()).toStrictEqual([expected]);
    for (const read of [
      () => resolveChoices()[0],
      () => declaredChoices()[0],
      () => resolveChoice("demo-key"),
      () => deprecatedChoice("old-demo"),
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
    expect(authFlags()).toStrictEqual([
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
    setPlugins(
      ["first", "second"].map((id) => ({
        id,
        origin: "global",
        providerAuthChoices: [{ provider: id, method: "oauth", choiceId: "shared-login" }],
      })),
    );

    expect(resolveChoice("shared-login")).toBeUndefined();
    expect(declaredChoices()).toEqual([]);
    expect(resolveChoices()).toEqual([]);
  });

  it.each(["darwin", "linux"] as const)(
    "keeps platform-limited setup choices and flags eligible only on %s",
    (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      const config = { plugins: { entries: { native: { enabled: true } } } };
      setPlugins([
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
            authMethod("native", "remote"),
            authMethod("native", "unavailable", { choiceId: "unavailable", platforms: [] }),
          ],
          setup: { providers: [{ id: "native", authMethods: ["local"] }] },
        },
      ]);

      const expectedIds =
        platform === "darwin" ? ["native-local", "native-remote"] : ["native-remote"];
      expect(resolveChoices({ config }).map((choice) => choice.choiceId)).toEqual(expectedIds);
      expect(declaredChoices({ config }).map((choice) => choice.choiceId)).toEqual(expectedIds);
      expect(Boolean(resolveChoice("native-local", { config }))).toBe(platform === "darwin");
      expect(Boolean(deprecatedChoice("old-native", { config }))).toBe(platform === "darwin");
      expect(authFlags({ config }).map((flag) => flag.authChoice)).toEqual(
        platform === "darwin" ? ["native-local"] : [],
      );
      expect(config.plugins.entries.native.enabled).toBe(true);
      expect(
        resolveChoices({ config, includeUnsupportedPlatforms: true }).map(
          (choice) => choice.choiceId,
        ),
      ).toEqual(["native-local", "native-remote", "unavailable"]);
    },
  );

  it("resolves explicit method identity before a conflicting manifest choice ID", () => {
    const explicitChoice = "provider-plugin:Demo:LOCAL";
    setPlugins([
      manifest("demo-plugin", [
        authMethod("demo", "local", { modelTarget: "utility" }),
        authMethod("demo", "remote"),
      ]),
      manifest("other-plugin", [authMethod("other", "remote", { choiceId: explicitChoice })]),
    ]);
    expect(resolveChoice(explicitChoice)).toMatchObject({
      pluginId: "demo-plugin",
      providerId: "demo",
      methodId: "local",
      choiceId: "demo-local",
      modelTarget: "utility",
    });
    expect(resolveChoice("provider-plugin:demo:remote")).toMatchObject({
      pluginId: "demo-plugin",
      providerId: "demo",
      methodId: "remote",
      choiceId: "demo-remote",
    });
    expect(resolveChoice("provider-plugin:demo:missing")).toBeUndefined();
  });

  it("binds post-dispatch method metadata to the selected plugin despite ambiguous provider declarations", () => {
    setPlugins(
      ["selected", "other"].map((id) =>
        manifest(id, [
          authMethod("demo", "local", {
            choiceId: `${id}-local`,
            ...(id === "selected" ? { modelTarget: "utility" } : {}),
          }),
        ]),
      ),
    );
    expect(resolveChoice("provider-plugin:demo:local")).toBeUndefined();
    expect(resolveChoice("provider-plugin:demo:local", { pluginId: "selected" })).toMatchObject({
      pluginId: "selected",
      modelTarget: "utility",
    });
  });

  it("excludes workspace and explicitly disabled owners from executable choices", () => {
    setPlugins(
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
    expect(declaredChoices({ config })).toEqual([]);
  });

  it("keeps installed manifest flags ahead of official cold-install flags", () => {
    setChoices("cerebras", [
      keyChoice("cerebras", "Cerebras", { cliDescription: "Installed Cerebras key" }),
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
                  ...keyChoice("cerebras", "Cerebras"),
                  cliDescription: "Catalog Cerebras key",
                },
                keyChoice("groq", "Groq"),
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

    expect(authFlags()).toEqual([
      expectedFlag("cerebras", "Installed Cerebras key"),
      expectedFlag("groq", "Groq API key"),
    ]);
  });

  it("deduplicates flag metadata by option key + flag", () => {
    setChoices("moonshot", [
      keyChoice("moonshot", "Moonshot", { choiceLabel: "Kimi API key (.ai)" }),
      keyChoice("moonshot", "Moonshot", {
        method: "api-key-cn",
        choiceId: "moonshot-api-key-cn",
        choiceLabel: "Kimi API key (.cn)",
      }),
    ]);
    expect(authFlags()).toEqual([expectedFlag("moonshot", "Moonshot API key")]);
  });

  it.each([true, false])("preserves legacy credential aliases with native realm=%s", (native) => {
    setPlugins([
      {
        ...manifest("anthropic", [
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
    expect(deprecatedChoice("claude-cli")?.choiceId).toBe("anthropic-cli");
    expect(authFlags()).toContainEqual(
      expect.objectContaining({ authChoice: "anthropic-cli", cliFlag: "--anthropic-cli" }),
    );
  });

  it("resolves deprecated auth-choice aliases through manifest metadata", () => {
    setChoices("minimax", [
      {
        provider: "minimax",
        method: "api-global",
        choiceId: "minimax-global-api",
        deprecatedChoiceIds: ["minimax", "minimax-api"],
      },
    ]);
    expect(resolveChoices()).toEqual([
      {
        pluginId: "minimax",
        providerId: "minimax",
        methodId: "api-global",
        choiceId: "minimax-global-api",
        choiceLabel: "minimax-global-api",
        deprecatedChoiceIds: ["minimax", "minimax-api"],
      },
    ]);
    for (const [alias, expected] of [
      ["minimax", "minimax-global-api"],
      ["minimax-api", "minimax-global-api"],
      ["openai", undefined],
    ] as const) {
      expect(deprecatedChoice(alias)?.choiceId).toBe(expected);
    }
  });
  it("can exclude untrusted workspace plugin auth choices during onboarding resolution", () => {
    const policy = { includeUntrustedWorkspacePlugins: false };
    const guided = {
      appGuidedSecret: true,
      appGuidedActionLabel: "Connect account",
      appGuidedDiscovery: true,
    };
    setPlugins([
      loginPlugin("openai", "bundled", "openai", guided),
      loginPlugin("evil-openai-hijack", "workspace", "evil-openai", {}, [
        {
          ...authMethod("evil-openai", "api-key"),
          ...choiceMetadata("evil-openai", "Evil OpenAI"),
          optionKey: "evilOpenaiApiKey",
        },
      ]),
    ]);

    expect(resolveChoices(policy)).toEqual([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        ...openaiChoiceMetadata,
        ...guided,
      },
    ]);
    expect(resolveChoice("openai-api-key", policy)?.providerId).toBe("openai");
    const enabledWorkspaceConfig = {
      plugins: { entries: { "evil-openai-hijack": { enabled: true } } },
    };
    expect(
      resolveChoices({
        config: enabledWorkspaceConfig,
        ...policy,
      }).map((choice) => choice.choiceId),
    ).toContain("evil-openai-api-key");
    expect(
      resolveChoices({
        config: enabledWorkspaceConfig,
        ...policy,
        includeWorkspacePlugins: false,
      }).map((choice) => choice.choiceId),
    ).not.toContain("evil-openai-api-key");
    expect(authFlags(policy)).toEqual([expectedFlag("openai", "OpenAI API key")]);
  });

  it.each([
    {
      name: "derives generic auth choices from descriptor-safe setup provider auth methods",
      plugin: setupPlugin("demo-provider", ["api-key", "oauth"], {
        name: "Demo Provider",
        requiresRuntime: false,
      }),
      expected: [
        expectedSetupChoice("demo-provider", "api-key", "Demo Provider", "API key"),
        expectedSetupChoice("demo-provider", "oauth", "Demo Provider", "OAuth"),
      ],
    },
    {
      name: "sanitizes setup provider auth descriptors before deriving prompt labels",
      plugin: setupPlugin("evil-provider", ["jwt\u001b[2K", "oidc"], {
        origin: "workspace",
        providerId: "evil\u001b[31m-provider",
        requiresRuntime: false,
      }),
      expected: [
        expectedSetupChoice("evil-provider", "jwt", "Evil Provider", "JWT"),
        expectedSetupChoice("evil-provider", "oidc", "Evil Provider", "OIDC"),
      ],
    },
    {
      name: "uses setup provider auth methods when no setup entry exists",
      plugin: setupPlugin("no-runtime-provider", ["api-key"]),
      expected: [
        expectedSetupChoice("no-runtime-provider", "api-key", "No Runtime Provider", "API key"),
      ],
      lookup: "no-runtime-provider-api-key",
    },
    {
      name: "keeps setup-entry providers on explicit manifest or runtime auth choices",
      plugin: setupPlugin("runtime-provider", ["api-key"], {
        setupSource: "/plugins/runtime-provider/setup-entry.cjs",
      }),
      expected: [],
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
        expectedSetupChoice("explicit-provider", "oauth", "Explicit Provider", "OAuth"),
      ],
    },
    {
      name: "keeps descriptor setup fallback out of executable declared choices",
      plugin: setupPlugin("descriptor", ["oauth"], { origin: "bundled" }),
      expected: [expectedSetupChoice("descriptor", "oauth", "Descriptor", "OAuth")],
    },
  ])("$name", ({ plugin, expected, lookup }) => {
    setPlugins([plugin]);
    expect(resolveChoices()).toStrictEqual(expected);
    if (lookup) {
      expect(resolveChoice(lookup)).toEqual(expected[0]);
    }
    if (plugin.id === "descriptor") {
      expect(declaredChoices()).toEqual([]);
    }
  });

  it.each([
    {
      name: "prefers bundled auth-choice handlers when choice IDs collide across origins",
      candidates: [
        ["evil-openai-hijack", "workspace", "evil-openai"],
        ["openai", "bundled", "openai"],
      ],
      expectedOwner: "openai",
    },
    {
      name: "prefers trusted config auth-choice handlers over bundled collisions",
      candidates: [
        ["openai", "bundled", "openai"],
        ["custom-openai", "config", "custom-openai"],
      ],
      expectedOwner: "custom-openai",
    },
  ] as const)("$name", ({ candidates, expectedOwner }) => {
    setPlugins(candidates.map(([id, origin, provider]) => loginPlugin(id, origin, provider)));
    expect(resolveChoices()).toEqual([
      {
        pluginId: expectedOwner,
        providerId: expectedOwner,
        methodId: "api-key",
        ...openaiChoiceMetadata,
      },
    ]);
    expect(resolveChoice("openai-api-key")?.providerId).toBe(expectedOwner);
    expect(authFlags()).toEqual([expectedFlag("openai", "OpenAI API key")]);
  });

  it("resolves manifest-owned provider auth aliases", () => {
    setPlugins([
      {
        id: "fixture-provider",
        origin: "bundled",
        providerAuthAliases: {
          "fixture-provider-plan": "fixture-provider",
        },
        providerAuthChoices: [
          {
            ...authMethod("fixture-provider", "api-key"),
            ...choiceMetadata("fixture-provider", "Fixture Provider"),
            optionKey: "fixtureProviderApiKey",
          },
        ],
      },
    ]);

    const resolvedProviderId = resolveProviderIdForAuth("fixture-provider-plan");
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).toHaveBeenCalled();
    expect(resolvedProviderId).toBe("fixture-provider");
  });
});
