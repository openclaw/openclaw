// Command secret target import tests cover lazy import safety for secret target metadata.
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";

function secretTarget(
  id: string,
  overrides: {
    targetType?: string;
    pathPattern?: string;
    refPathPattern?: string;
    secretShape?: "secret_input" | "sibling_ref";
  } = {},
) {
  return {
    id,
    targetType: id,
    configFile: "openclaw.json",
    pathPattern: id,
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    ...overrides,
  };
}

describe("command secret targets module import", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads independent model credential target sets without channel or web discovery", async () => {
    const denyUnrelatedImport = () => {
      throw new Error("Model targets loaded channel or web discovery");
    };
    // mock-isolation: Channel metadata must throw on import to detect eager channel discovery.
    vi.doMock("../channels/plugins/read-only.js", denyUnrelatedImport);
    // mock-isolation: The web fetch provider runtime must throw on import to detect eager discovery.
    vi.doMock("../plugins/web-fetch-providers.runtime.js", denyUnrelatedImport);
    // mock-isolation: The web search provider runtime must throw on import to detect eager discovery.
    vi.doMock("../plugins/web-search-providers.runtime.js", denyUnrelatedImport);
    try {
      const { getModelsCommandSecretTargetIds } = await import("./model-secret-targets.js");
      const ids = getModelsCommandSecretTargetIds();
      ids.clear();
      expect(getModelsCommandSecretTargetIds()).toEqual(
        new Set([
          "models.providers.*.apiKey",
          "models.providers.*.headers.*",
          "models.providers.*.request.headers.*",
          "models.providers.*.request.auth.token",
          "models.providers.*.request.auth.value",
          "models.providers.*.request.proxy.tls.ca",
          "models.providers.*.request.proxy.tls.cert",
          "models.providers.*.request.proxy.tls.key",
          "models.providers.*.request.proxy.tls.passphrase",
          "models.providers.*.request.tls.ca",
          "models.providers.*.request.tls.cert",
          "models.providers.*.request.tls.key",
          "models.providers.*.request.tls.passphrase",
        ]),
      );
    } finally {
      vi.doUnmock("../channels/plugins/read-only.js");
      vi.doUnmock("../plugins/web-fetch-providers.runtime.js");
      vi.doUnmock("../plugins/web-search-providers.runtime.js");
    }
  });

  it("resolves model credentials without loading the web-tool runtime", async () => {
    // mock-isolation: A model-only command must not initialize the web provider runtime.
    vi.doMock("../secrets/runtime-web-tools.js", () => {
      throw new Error("Model credential resolution loaded the web runtime");
    });
    vi.stubEnv("OPENCLAW_TEST_MODEL_KEY", "fixture-model-key");
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
    try {
      const { resolveCommandSecretRefsViaGateway } = await import("./command-secret-gateway.js");
      const { getModelsCommandSecretTargetIds } = await import("./model-secret-targets.js");
      const result = await resolveCommandSecretRefsViaGateway({
        config: {
          models: {
            providers: {
              fixture: {
                baseUrl: "https://provider.example/v1",
                apiKey: { source: "env", provider: "default", id: "OPENCLAW_TEST_MODEL_KEY" },
                models: [],
              },
            },
          },
        },
        commandName: "infer model run",
        targetIds: getModelsCommandSecretTargetIds(),
        localGatewayAbsent: true,
      });
      expect(result.resolvedConfig.models?.providers?.fixture?.apiKey).toBe("fixture-model-key");
      expect(result.hadUnresolvedTargets).toBe(false);
    } finally {
      vi.doUnmock("../secrets/runtime-web-tools.js");
      vi.unstubAllEnvs();
    }
  });

  it("can resolve configured-channel status targets without the full registry", async () => {
    const listSecretTargetRegistryEntries = vi.fn(() => {
      throw new Error("registry touched too early");
    });
    const listReadOnlyChannelPluginsForConfig = vi.fn(() => [
      {
        id: "telegram",
        secrets: {
          secretTargetRegistryEntries: [
            secretTarget("channels.telegram.botToken"),
            secretTarget("channels.telegram.gatewayToken", {
              targetType: "gateway.auth.token",
              pathPattern: "gateway.auth.token",
            }),
            secretTarget("channels.telegram.gatewayTokenRef", {
              pathPattern: "channels.telegram.gatewayToken",
              refPathPattern: "gateway.auth.token",
              secretShape: "sibling_ref",
            }),
            secretTarget("channels.discord.token"),
          ],
        },
      },
      {
        id: "external-chat",
        secrets: {
          secretTargetRegistryEntries: [secretTarget("channels.external-chat.token")],
        },
      },
    ]);

    vi.doMock("../secrets/target-registry.js", () => ({
      discoverConfigSecretTargetsByIds: vi.fn(() => []),
      listSecretTargetRegistryEntries,
    }));
    vi.doMock("../channels/plugins/read-only.js", () => ({
      listReadOnlyChannelPluginsForConfig,
    }));

    const mod = await import("./command-secret-targets.js");
    const targets = mod.getStatusCommandSecretTargetIds({
      channels: {
        "external-chat": { token: "configured" },
        telegram: { botToken: "123456:ABCDEF" },
      },
    });

    expect(targets.has("channels.external-chat.token")).toBe(true);
    expect(targets.has("channels.telegram.botToken")).toBe(true);
    expect(targets.has("channels.discord.token")).toBe(false);
    expect(targets.has("channels.telegram.gatewayToken")).toBe(false);
    expect(targets.has("channels.telegram.gatewayTokenRef")).toBe(false);
    expect(targets.has("gateway.auth.token")).toBe(true);
    expect(targets.has("gateway.auth.password")).toBe(true);
    expect(targets.has("gateway.remote.token")).toBe(true);
    expect(targets.has("gateway.remote.password")).toBe(true);
    expect(targets.has("memory.search.remote.apiKey")).toBe(true);
    const pluginCall = listReadOnlyChannelPluginsForConfig.mock.calls[0] as unknown as
      | [unknown, { includePersistedAuthState?: boolean }]
      | undefined;
    expect(typeof pluginCall?.[0]).toBe("object");
    expect(pluginCall?.[1]?.includePersistedAuthState).toBe(false);
    expect(listSecretTargetRegistryEntries).not.toHaveBeenCalled();
  });
});
