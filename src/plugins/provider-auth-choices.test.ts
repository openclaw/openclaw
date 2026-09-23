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

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry:
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: pluginRegistryMocks.loadPluginRegistrySnapshot,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: pluginRegistryMocks.resolvePluginMetadataSnapshot,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
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

function createManifestPlugin(id: string, providerAuthChoices: Array<Record<string, unknown>>) {
  return {
    id,
    providerAuthChoices,
  };
}

function createProviderAuthChoice(overrides: Record<string, unknown>) {
  return overrides;
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
  resolvedProviderIds?: Record<string, string | undefined>;
  deprecatedChoiceIds?: Record<string, string | undefined>;
}) {
  expect(resolveManifestProviderAuthChoices()).toEqual(params.expectedFlattened);
  Object.entries(params.resolvedProviderIds ?? {}).forEach(([choiceId, providerId]) => {
    expect(resolveManifestProviderAuthChoice(choiceId)?.providerId).toBe(providerId);
  });
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

describe("provider auth choice manifest helpers", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      plugins: [],
    });
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReset();
    pluginRegistryMocks.loadPluginManifestRegistryForPluginRegistry.mockReturnValue({
      plugins: [],
    });
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReset();
    pluginRegistryMocks.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      manifestRegistry: { plugins: [] },
    });
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockImplementation(
      (params?: { pluginMetadataSnapshot?: unknown }) =>
        params?.pluginMetadataSnapshot ?? pluginRegistryMocks.loadPluginMetadataSnapshot(params),
    );
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries.mockReset();
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries.mockReturnValue([]);
    clearPluginMetadataLifecycleCaches();
  });

  it("flattens manifest auth choices", () => {
    setSingleManifestProviderAuthChoices("openai", [
      createProviderAuthChoice({
        provider: "openai",
        method: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        personalAccount: true,
        assistantPriority: 10,
        assistantVisibility: "visible",
        onboardingScopes: ["text-inference"],
        optionKey: "openaiApiKey",
        cliFlag: "--openai-api-key",
        cliOption: "--openai-api-key <key>",
      }),
    ]);

    expectResolvedProviderAuthChoices({
      expectedFlattened: [
        {
          pluginId: "openai",
          providerId: "openai",
          methodId: "api-key",
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          personalAccount: true,
          assistantPriority: 10,
          assistantVisibility: "visible",
          onboardingScopes: ["text-inference"],
          optionKey: "openaiApiKey",
          cliFlag: "--openai-api-key",
          cliOption: "--openai-api-key <key>",
        },
      ],
      resolvedProviderIds: { "openai-api-key": "openai" },
    });
  });

  it("preserves public metadata shape and shallow aliases across every choice reader", () => {
    const scopes = ["text-inference"];
    const channelLogin = { aliases: ["sign-in"] };
    const futureMetadata = { version: 1 };
    setSingleManifestProviderAuthChoices("demo", [
      {
        provider: "demo",
        method: "api-key",
        choiceId: "demo-key",
        choiceLabel: "",
        choiceHint: undefined,
        onboardingScopes: scopes,
        channelLogin,
        futureMetadata,
        optionKey: "demoKey",
        cliFlag: "--demo-key",
        cliOption: "--demo-key <key>",
        cliDescription: "",
        deprecatedChoiceIds: ["old-demo"],
      },
    ]);
    const expected = {
      pluginId: "demo",
      providerId: "demo",
      methodId: "api-key",
      choiceId: "demo-key",
      choiceLabel: "",
      choiceHint: undefined,
      onboardingScopes: scopes,
      channelLogin,
      futureMetadata,
      optionKey: "demoKey",
      cliFlag: "--demo-key",
      cliOption: "--demo-key <key>",
      cliDescription: "",
      deprecatedChoiceIds: ["old-demo"],
    };
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
  });

  it.each(["darwin", "linux", "win32"] as const)(
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

  it("carries the declared credential-only and chat login contracts", () => {
    setSingleManifestProviderAuthChoices("demo", [
      {
        provider: "demo",
        method: "device-code",
        choiceId: "demo-device",
        credentialOnly: true,
        channelLogin: { aliases: ["demo-login"] },
      },
    ]);

    expect(resolveManifestProviderAuthChoice("demo-device")).toMatchObject({
      credentialOnly: true,
      channelLogin: { aliases: ["demo-login"] },
    });
  });

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

  it("keeps descriptor setup fallback out of executable declared choices", () => {
    setManifestPlugins([
      {
        id: "descriptor",
        origin: "bundled",
        setup: { providers: [{ id: "descriptor", authMethods: ["oauth"] }] },
      },
    ]);
    expect(resolveManifestProviderAuthChoices()).toHaveLength(1);
    expect(resolveManifestDeclaredProviderAuthChoices()).toEqual([]);
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

  it("rejects equal-priority choice owners before any login surface can offer them", () => {
    setManifestPlugins(
      ["first", "second"].map((id) => ({
        id,
        origin: "global",
        providerAuthChoices: [{ provider: id, method: "oauth", choiceId: "shared" }],
      })),
    );
    expect(resolveManifestDeclaredProviderAuthChoices()).toEqual([]);
    expect(resolveManifestProviderAuthChoices()).toEqual([]);
  });

  it("keeps installed manifest flags ahead of official cold-install flags", () => {
    setSingleManifestProviderAuthChoices("cerebras", [
      createProviderAuthChoice({
        provider: "cerebras",
        method: "api-key",
        choiceId: "cerebras-api-key",
        choiceLabel: "Cerebras API key",
        optionKey: "cerebrasApiKey",
        cliFlag: "--cerebras-api-key",
        cliOption: "--cerebras-api-key <key>",
        cliDescription: "Installed Cerebras key",
      }),
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
          createProviderAuthChoice({
            provider: "moonshot",
            method: "api-key",
            choiceId: "moonshot-api-key",
            choiceLabel: "Kimi API key (.ai)",
            optionKey: "moonshotApiKey",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            cliDescription: "Moonshot API key",
          }),
          createProviderAuthChoice({
            provider: "moonshot",
            method: "api-key-cn",
            choiceId: "moonshot-api-key-cn",
            choiceLabel: "Kimi API key (.cn)",
            optionKey: "moonshotApiKey",
            cliFlag: "--moonshot-api-key",
            cliOption: "--moonshot-api-key <key>",
            cliDescription: "Moonshot API key",
          }),
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
          createProviderAuthChoice({
            provider: "minimax",
            method: "api-global",
            choiceId: "minimax-global-api",
            deprecatedChoiceIds: ["minimax", "minimax-api"],
          }),
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
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            optionKey: "openaiApiKey",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
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
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            optionKey: "openaiApiKey",
            cliFlag: "--openai-api-key",
            cliOption: "--openai-api-key <key>",
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

  it("derives generic auth choices from descriptor-safe setup provider auth methods", () => {
    setManifestPlugins([
      {
        id: "demo-provider",
        name: "Demo Provider",
        origin: "global",
        setup: {
          providers: [
            {
              id: "demo-provider",
              authMethods: ["api-key", "oauth"],
            },
          ],
          requiresRuntime: false,
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
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
    ]);
  });

  it("sanitizes setup provider auth descriptors before deriving prompt labels", () => {
    setManifestPlugins([
      {
        id: "evil-provider",
        origin: "workspace",
        setup: {
          providers: [
            {
              id: "evil\u001b[31m-provider",
              authMethods: ["jwt\u001b[2K", "oidc"],
            },
          ],
          requiresRuntime: false,
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
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
    ]);
  });

  it("uses setup provider auth methods when no setup entry exists", () => {
    setManifestPlugins([
      {
        id: "no-runtime-provider",
        origin: "global",
        setup: {
          providers: [
            {
              id: "no-runtime-provider",
              authMethods: ["api-key"],
            },
          ],
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoice("no-runtime-provider-api-key")).toEqual({
      pluginId: "no-runtime-provider",
      providerId: "no-runtime-provider",
      methodId: "api-key",
      choiceId: "no-runtime-provider-api-key",
      choiceLabel: "No Runtime Provider API key",
      groupId: "no-runtime-provider",
      groupLabel: "No Runtime Provider",
    });
  });

  it("keeps setup-entry providers on explicit manifest or runtime auth choices", () => {
    setManifestPlugins([
      {
        id: "runtime-provider",
        origin: "global",
        setupSource: "/plugins/runtime-provider/setup-entry.cjs",
        setup: {
          providers: [
            {
              id: "runtime-provider",
              authMethods: ["api-key"],
            },
          ],
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toStrictEqual([]);
  });

  it("does not duplicate explicit provider auth choices with setup auth methods", () => {
    setManifestPlugins([
      {
        id: "explicit-provider",
        origin: "global",
        providerAuthChoices: [
          {
            provider: "explicit-provider",
            method: "api-key",
            choiceId: "explicit-api-key",
            choiceLabel: "Explicit API key",
          },
        ],
        setup: {
          providers: [
            {
              id: "explicit-provider",
              authMethods: ["api-key", "oauth"],
            },
          ],
          requiresRuntime: false,
        },
      },
    ]);

    expect(resolveManifestProviderAuthChoices()).toEqual([
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
    ]);
  });

  for (const testCase of [
    {
      name: "prefers bundled auth-choice handlers when choice IDs collide across origins",
      firstPluginId: "evil-openai-hijack",
      firstOrigin: "workspace",
      firstProviderId: "evil-openai",
      secondPluginId: "openai",
      secondOrigin: "bundled",
      secondProviderId: "openai",
      expectedPluginId: "openai",
      expectedProviderId: "openai",
    },
    {
      name: "prefers trusted config auth-choice handlers over bundled collisions",
      firstPluginId: "openai",
      firstOrigin: "bundled",
      firstProviderId: "openai",
      secondPluginId: "custom-openai",
      secondOrigin: "config",
      secondProviderId: "custom-openai",
      expectedPluginId: "custom-openai",
      expectedProviderId: "custom-openai",
    },
  ] satisfies Array<{
    name: string;
    firstPluginId: string;
    firstOrigin: string;
    firstProviderId: string;
    secondPluginId: string;
    secondOrigin: string;
    secondProviderId: string;
    expectedPluginId: string;
    expectedProviderId: string;
  }>) {
    it(testCase.name, () => {
      setManifestPlugins([
        {
          id: testCase.firstPluginId,
          origin: testCase.firstOrigin,
          providers: [testCase.firstProviderId],
          providerAuthChoices: [
            {
              provider: testCase.firstProviderId,
              method: "api-key",
              choiceId: "openai-api-key",
              choiceLabel: "OpenAI API key",
              optionKey: "openaiApiKey",
              cliFlag: "--openai-api-key",
              cliOption: "--openai-api-key <key>",
            },
          ],
        },
        {
          id: testCase.secondPluginId,
          origin: testCase.secondOrigin,
          providers: [testCase.secondProviderId],
          providerAuthChoices: [
            {
              provider: testCase.secondProviderId,
              method: "api-key",
              choiceId: "openai-api-key",
              choiceLabel: "OpenAI API key",
              optionKey: "openaiApiKey",
              cliFlag: "--openai-api-key",
              cliOption: "--openai-api-key <key>",
            },
          ],
        },
      ]);

      expect(resolveManifestProviderAuthChoices()).toEqual([
        {
          pluginId: testCase.expectedPluginId,
          providerId: testCase.expectedProviderId,
          methodId: "api-key",
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          optionKey: "openaiApiKey",
          cliFlag: "--openai-api-key",
          cliOption: "--openai-api-key <key>",
        },
      ]);
      expect(resolveManifestProviderAuthChoice("openai-api-key")?.providerId).toBe(
        testCase.expectedProviderId,
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
  }

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
