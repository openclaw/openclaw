import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pluginRegistryMocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshot: vi.fn(),
}));
const officialCatalogMocks = vi.hoisted(() => ({
  listOfficialExternalProviderCatalogEntries: vi.fn(),
}));

// mock-isolation: Keep metadata-only choice tests independent of plugin discovery state.
vi.mock("./plugin-metadata-snapshot.js", () => ({
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

function expectedChoice(pluginId: string, providerId: string, methodId: string, metadata = {}) {
  return {
    pluginId,
    providerId,
    methodId,
    choiceId: `${providerId}-${methodId}`,
    choiceLabel: `${providerId}-${methodId}`,
    ...metadata,
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
  pluginRegistryMocks.resolvePluginMetadataSnapshot.mockReturnValue({
    plugins,
    manifestRegistry: { plugins },
  });
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
    setPlugins([]);
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries.mockReset();
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries.mockReturnValue([]);
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
    const expected = expectedChoice("demo", "demo", "api-key", metadata);
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
      expect(value.onboardingScopes).toBe(scopes);
      expect(value.channelLogin).toBe(channelLogin);
      expect(Reflect.get(value, "futureMetadata")).toBe(futureMetadata);
      const again = read();
      expect(Object.is(value, again)).toBe(false);
      value.choiceLabel = "changed output";
      expect(again).toStrictEqual(expected);
    }
    expect(deprecatedChoice("unknown")).toBeUndefined();
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
            authMethod("native", "local", {
              platforms: ["darwin"],
              deprecatedChoiceIds: ["old-native"],
              optionKey: "nativeLocal",
              cliFlag: "--native-local",
              cliOption: "--native-local",
            }),
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
    expect(resolveChoice(explicitChoice)).toMatchObject(
      expectedChoice("demo-plugin", "demo", "local", { modelTarget: "utility" }),
    );
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

  it("deduplicates installed flags before adding eligible cold-install flags", () => {
    const installed = keyChoice("cerebras", "Cerebras", {
      cliDescription: "Installed Cerebras key",
    });
    setChoices("cerebras", [installed, { ...installed, method: "other", choiceId: "other-key" }]);
    const authChoices = [
      keyChoice("cerebras", "Cerebras", { cliDescription: "Catalog Cerebras key" }),
      keyChoice("groq", "Groq"),
      keyChoice("unavailable", "Unavailable", { platforms: [] }),
    ];
    officialCatalogMocks.listOfficialExternalProviderCatalogEntries.mockReturnValue([
      { openclaw: { providers: [{ authChoices }] } },
    ]);

    expect(authFlags()).toEqual([
      expectedFlag("cerebras", "Installed Cerebras key"),
      expectedFlag("groq", "Groq API key"),
    ]);
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
        keyChoice("evil-openai", "Evil OpenAI", { optionKey: "evilOpenaiApiKey" }),
      ]),
    ]);

    expect(resolveChoices(policy)).toEqual([
      expectedChoice("openai", "openai", "api-key", { ...openaiChoiceMetadata, ...guided }),
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
    ["descriptor-safe", ["api-key", "oauth"], { requiresRuntime: false }, ["api-key", "oauth"]],
    [
      "sanitized",
      ["jwt\u001b[2K", "oidc"],
      { origin: "workspace", providerId: "de\u001b[31mmo-provider", requiresRuntime: false },
      ["jwt", "oidc"],
    ],
    ["no setup entry", ["api-key"], {}, ["api-key"]],
    ["runtime entry", ["api-key"], { setupSource: "/plugins/demo/setup.cjs" }, []],
    ["non-executable fallback", ["oauth"], { origin: "bundled" }, ["oauth"]],
  ] as const)("derives setup choices: %s", (name, methods, options, expectedMethods) => {
    const plugin = setupPlugin("demo-provider", [...methods], options);
    setPlugins([plugin]);
    const labels = { "api-key": "API key", oauth: "OAuth", jwt: "JWT", oidc: "OIDC" };
    const expected = expectedMethods.map((method) =>
      expectedChoice("demo-provider", "demo-provider", method, {
        choiceLabel: `Demo Provider ${labels[method]}`,
        groupId: "demo-provider",
        groupLabel: "Demo Provider",
      }),
    );
    expect(resolveChoices()).toStrictEqual(expected);
    const first = expected[0];
    if (first) {
      expect(resolveChoice(first.choiceId)).toEqual(first);
    }
    if (name === "non-executable fallback") {
      expect(declaredChoices()).toEqual([]);
    }
  });

  it("does not synthesize a duplicate of an explicitly declared setup method", () => {
    const declared = authMethod("demo", "api-key", { choiceId: "explicit", choiceLabel: "Key" });
    setPlugins([setupPlugin("demo", ["api-key", "oauth"], { providerAuthChoices: [declared] })]);
    expect(resolveChoices()).toStrictEqual([
      expectedChoice("demo", "demo", "api-key", { choiceId: "explicit", choiceLabel: "Key" }),
      expectedChoice("demo", "demo", "oauth", {
        choiceLabel: "Demo OAuth",
        groupId: "demo",
        groupLabel: "Demo",
      }),
    ]);
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
      expectedChoice(expectedOwner, expectedOwner, "api-key", openaiChoiceMetadata),
    ]);
    expect(resolveChoice("openai-api-key")?.providerId).toBe(expectedOwner);
    expect(authFlags()).toEqual([expectedFlag("openai", "OpenAI API key")]);
  });
});
