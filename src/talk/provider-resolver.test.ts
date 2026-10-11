// Talk provider resolver tests cover provider selection from config.
import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { InternalRealtimeVoiceProviderApi } from "./provider-internal.js";
import {
  resolveConfiguredRealtimeVoiceProvider,
  resolveConfiguredRealtimeVoiceProviderAsync,
  resolveRealtimeVoiceProviderCapabilitiesAsync,
} from "./provider-resolver.js";

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

function attachInternalRealtimeVoiceProviderApi(
  provider: RealtimeVoiceProviderPlugin,
  api: InternalRealtimeVoiceProviderApi,
): void {
  Object.defineProperty(provider, INTERNAL_REALTIME_VOICE_PROVIDER, {
    configurable: true,
    value: api,
  });
}

describe("realtime voice provider resolver", () => {
  const providers: RealtimeVoiceProviderPlugin[] = [
    {
      id: "first",
      label: "First",
      autoSelectOrder: 1,
      isConfigured: () => false,
      createBridge: () => {
        throw new Error("unused");
      },
    },
    {
      id: "second",
      label: "Second",
      autoSelectOrder: 2,
      resolveConfig: ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
      isConfigured: ({ providerConfig }) => providerConfig.enabled === true,
      createBridge: () => {
        throw new Error("unused");
      },
    },
  ];

  it("auto-selects the first configured realtime voice provider", () => {
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      providers,
      providerConfigs: {
        second: { enabled: true },
      },
    });

    expect(resolution).toStrictEqual({
      capabilities: undefined,
      provider: providers[1],
      providerConfig: {
        enabled: true,
        resolved: true,
      },
    });
  });

  it("awaits async provider hooks in priority order and applies session overrides", async () => {
    const legacyHook = vi.fn(() => {
      throw new Error("synchronous credential lookup must not run");
    });
    const attempted: string[] = [];
    const asyncProviders: RealtimeVoiceProviderPlugin[] = providers.map((provider) => ({
      ...provider,
      resolveConfig: legacyHook,
      isConfigured: legacyHook,
      resolveConfigAsync: async ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
      isConfiguredAsync: async ({ providerConfig }) => {
        attempted.push(provider.id);
        return providerConfig.enabled === true;
      },
    }));

    const resolution = await resolveConfiguredRealtimeVoiceProviderAsync({
      cfg: {},
      providers: asyncProviders.toReversed(),
      defaultModel: "default-model",
      providerConfigs: { second: { enabled: true, model: "configured-model" } },
      providerConfigOverrides: { model: "session-model" },
    });

    expect(attempted).toEqual(["first", "second"]);
    expect(resolution.provider.id).toBe("second");
    expect(resolution.providerConfig).toEqual({
      enabled: true,
      model: "session-model",
      resolved: true,
    });
    expect(legacyHook).not.toHaveBeenCalled();
  });

  it("awaits browser readiness and capabilities without reading legacy credentials", async () => {
    const legacyHook = vi.fn(() => {
      throw new Error("synchronous browser credential lookup must not run");
    });
    const provider: RealtimeVoiceProviderPlugin = {
      ...providers[0]!,
      isConfigured: legacyHook,
    };
    attachInternalRealtimeVoiceProviderApi(provider, {
      isBrowserSessionConfigured: legacyHook,
      resolveBrowserSessionCapabilities: legacyHook,
      isBrowserSessionConfiguredAsync: async ({ agentId }) => agentId === "voice-agent",
      resolveBrowserSessionCapabilitiesAsync: async ({ agentId }) => ({
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsGatewayControl: agentId === "voice-agent",
      }),
    });

    const resolution = await resolveConfiguredRealtimeVoiceProviderAsync({
      configuredProviderId: provider.id,
      providers: [provider],
      agentId: "voice-agent",
      surface: "browser-session",
    });

    expect(resolution.provider).toBe(provider);
    expect(resolution.capabilities?.supportsGatewayControl).toBe(true);
    expect(legacyHook).not.toHaveBeenCalled();
  });

  it.each(["resolveConfigAsync", "isConfiguredAsync"] as const)(
    "propagates %s rejection without synchronous fallback",
    async (hook) => {
      const failure = new Error("credential owner unavailable");
      const legacyHook = vi.fn(() => true);
      const legacyResolveConfig = vi.fn(() => ({}));
      const provider: RealtimeVoiceProviderPlugin = {
        ...providers[0]!,
        resolveConfig: legacyResolveConfig,
        isConfigured: legacyHook,
        [hook]: async () => {
          throw failure;
        },
      };

      await expect(
        resolveConfiguredRealtimeVoiceProviderAsync({
          configuredProviderId: provider.id,
          providers: [provider],
        }),
      ).rejects.toBe(failure);
      expect(legacyHook).not.toHaveBeenCalled();
      if (hook === "resolveConfigAsync") {
        expect(legacyResolveConfig).not.toHaveBeenCalled();
      }
    },
  );

  it("skips unavailable providers before resolving auto-selected config", () => {
    const unavailableResolveConfig = vi.fn(() => {
      throw new Error("unavailable provider config must not be resolved");
    });
    const unavailable: RealtimeVoiceProviderPlugin = {
      ...providers[0]!,
      resolveConfig: unavailableResolveConfig,
      isConfigured: () => true,
    };

    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      providers: [unavailable, providers[1]!],
      providerConfigs: {
        second: { enabled: true },
      },
      isProviderAvailable: (provider) => provider.id !== unavailable.id,
    });

    expect(unavailableResolveConfig).not.toHaveBeenCalled();
    expect(resolution.provider).toBe(providers[1]);
  });

  it("preserves the typed availability error when every auto provider is unavailable", () => {
    class ProviderUnavailableError extends Error {}
    const unavailable = new ProviderUnavailableError("provider owner is unavailable");
    const assertProviderAvailable = vi.fn(() => {
      throw unavailable;
    });

    expect(() =>
      resolveConfiguredRealtimeVoiceProvider({
        cfg: {},
        providers,
        isProviderAvailable: () => false,
        assertProviderAvailable,
      }),
    ).toThrow(unavailable);
    expect(assertProviderAvailable).toHaveBeenCalledOnce();
    expect(assertProviderAvailable).toHaveBeenCalledWith(providers[0]);
  });

  it("passes the requested agent scope to explicitly selected provider checks", () => {
    const isConfigured = vi.fn(() => true);
    const provider: RealtimeVoiceProviderPlugin = {
      id: "agent-scoped",
      label: "Agent scoped",
      isConfigured,
      createBridge: () => {
        throw new Error("unused");
      },
    };

    resolveConfiguredRealtimeVoiceProvider({
      agentId: "voice-agent",
      cfg: {},
      configuredProviderId: provider.id,
      providers: [provider],
    });

    expect(isConfigured).toHaveBeenCalledWith({
      agentId: "voice-agent",
      cfg: {},
      providerConfig: {},
    });
  });

  it.each([
    { surface: "browser-session", requiredCapabilities: { supportsVideoFrames: true } },
    { surface: "gateway-relay", autoRespondToAudio: false },
  ] as const)("normalizes provider config with the $surface session context", (sessionContext) => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "scoped",
      label: "Scoped voice",
      resolveConfig: ({
        rawConfig,
        agentId,
        surface,
        autoRespondToAudio,
        requiredCapabilities,
      }) => ({
        ...rawConfig,
        model: `${agentId}/${surface}`,
        autoRespondToAudio,
        requiredCapabilities,
      }),
      isConfigured: ({ providerConfig }) =>
        providerConfig.model === `voice-agent/${sessionContext.surface}`,
      createBridge: () => {
        throw new Error("unused");
      },
    };

    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      agentId: "voice-agent",
      providerConfigs: { scoped: { apiKey: "test-key" } },
      providers: [provider],
      ...sessionContext,
    });

    expect(resolution.providerConfig).toEqual({
      apiKey: "test-key",
      model: `voice-agent/${sessionContext.surface}`,
      autoRespondToAudio: "autoRespondToAudio" in sessionContext ? false : undefined,
      requiredCapabilities:
        "requiredCapabilities" in sessionContext ? { supportsVideoFrames: true } : undefined,
    });
  });

  it("keeps browser-only providers out of bridge auto-selection", () => {
    const isBrowserSessionConfigured = vi.fn(
      ({ agentId }: { agentId?: string }) => agentId === "voice-agent",
    );
    const browserOnly: RealtimeVoiceProviderPlugin = {
      id: "browser-only",
      label: "Browser only",
      autoSelectOrder: 1,
      isConfigured: () => false,
      createBridge: () => {
        throw new Error("unused");
      },
    };
    attachInternalRealtimeVoiceProviderApi(browserOnly, {
      isBrowserSessionConfigured,
    });
    const bridge: RealtimeVoiceProviderPlugin = {
      id: "bridge",
      label: "Bridge",
      autoSelectOrder: 2,
      isConfigured: () => true,
      createBridge: () => {
        throw new Error("unused");
      },
    };

    expect(
      resolveConfiguredRealtimeVoiceProvider({
        cfg: {},
        providers: [browserOnly, bridge],
      }).provider.id,
    ).toBe("bridge");
    expect(
      resolveConfiguredRealtimeVoiceProvider({
        cfg: {},
        agentId: "voice-agent",
        providers: [browserOnly, bridge],
        surface: "browser-session",
      }).provider.id,
    ).toBe("browser-only");
    expect(isBrowserSessionConfigured).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "voice-agent" }),
    );
  });

  it("limits internal relay readiness to the gateway-relay surface", () => {
    const relayOnly: RealtimeVoiceProviderPlugin = {
      id: "relay-only",
      label: "Relay only",
      isConfigured: () => false,
      createBridge: () => {
        throw new Error("unused");
      },
    };
    attachInternalRealtimeVoiceProviderApi(relayOnly, {
      isBrowserSessionConfigured: () => false,
      isGatewayRelayConfigured: () => true,
    });

    expect(() =>
      resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: "relay-only",
        providers: [relayOnly],
        surface: "bridge",
      }),
    ).toThrow('Realtime voice provider "relay-only" is not configured');
    expect(
      resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: "relay-only",
        providers: [relayOnly],
        surface: "gateway-relay",
      }).provider,
    ).toBe(relayOnly);
  });

  it("treats internal surface readiness as authoritative", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "surface-aware",
      label: "Surface aware",
      isConfigured: () => true,
      createBridge: () => {
        throw new Error("unused");
      },
    };
    attachInternalRealtimeVoiceProviderApi(provider, {
      isBrowserSessionConfigured: () => false,
      isGatewayRelayConfigured: () => false,
    });

    expect(() =>
      resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: provider.id,
        providers: [provider],
        surface: "browser-session",
      }),
    ).toThrow('Realtime voice provider "surface-aware" is not configured');
    expect(() =>
      resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: provider.id,
        providers: [provider],
        surface: "gateway-relay",
      }),
    ).toThrow('Realtime voice provider "surface-aware" is not configured');
  });

  it("falls back to public readiness when a surface hook is indeterminate", () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "surface-fallback",
      label: "Surface fallback",
      isConfigured: () => true,
      createBridge: () => {
        throw new Error("unused");
      },
    };
    attachInternalRealtimeVoiceProviderApi(provider, {
      isBrowserSessionConfigured: () => false,
      isGatewayRelayConfigured: () => undefined,
    });

    expect(
      resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: provider.id,
        providers: [provider],
        surface: "gateway-relay",
      }).provider,
    ).toBe(provider);
  });

  it("applies a default model before provider config resolution", () => {
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      configuredProviderId: "second",
      defaultModel: "gpt-realtime",
      providers,
      providerConfigs: {
        second: { enabled: true },
      },
    });

    expect(resolution.providerConfig).toStrictEqual({
      enabled: true,
      model: "gpt-realtime",
      resolved: true,
    });
  });

  it("keeps explicit provider model over the default model", () => {
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      configuredProviderId: "second",
      defaultModel: "gpt-realtime",
      providers,
      providerConfigs: {
        second: { enabled: true, model: "custom-realtime" },
      },
    });

    expect(resolution.providerConfig).toStrictEqual({
      enabled: true,
      model: "custom-realtime",
      resolved: true,
    });
  });

  it("applies caller overrides to the auto-selected realtime voice provider", () => {
    const resolution = resolveConfiguredRealtimeVoiceProvider({
      cfg: {},
      defaultModel: "gpt-realtime",
      providerConfigOverrides: {
        model: "gpt-realtime-2",
        voice: "cedar",
      },
      providers,
      providerConfigs: {
        second: { enabled: true, model: "provider-default", voice: "marin" },
      },
    });

    expect(resolution.providerConfig).toStrictEqual({
      enabled: true,
      model: "gpt-realtime-2",
      voice: "cedar",
      resolved: true,
    });
  });

  it("throws a caller-specified message when no providers exist", () => {
    expect(() =>
      resolveConfiguredRealtimeVoiceProvider({
        cfg: {},
        providers: [],
        noRegisteredProviderMessage: "No configured realtime voice provider registered",
      }),
    ).toThrow("No configured realtime voice provider registered");
  });

  it("resolves config-specific provider capabilities", async () => {
    const provider: RealtimeVoiceProviderPlugin = {
      id: "dynamic",
      label: "Dynamic",
      capabilities: {
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsVideoFrames: true,
      },
      isConfigured: () => true,
      createBridge: () => {
        throw new Error("unused");
      },
    };
    attachInternalRealtimeVoiceProviderApi(provider, {
      isBrowserSessionConfigured: () => true,
      resolveBrowserSessionCapabilities: ({ providerConfig, agentId, model }) => ({
        transports: ["webrtc"],
        inputAudioFormats: [],
        outputAudioFormats: [],
        supportsVideoFrames: providerConfig.authMode !== "native" && model === "gpt-live-1",
        supportsGatewayControl: agentId === "molty",
      }),
    });

    expect(
      (
        await resolveRealtimeVoiceProviderCapabilitiesAsync({
          provider,
          providerConfig: { authMode: "native" },
          model: "gpt-live-1",
          surface: "browser-session",
        })
      )?.supportsVideoFrames,
    ).toBe(false);
    const scopedCapabilities = await resolveRealtimeVoiceProviderCapabilitiesAsync({
      provider,
      providerConfig: { authMode: "oauth" },
      agentId: "molty",
      model: "gpt-live-1",
      surface: "browser-session",
    });
    expect(scopedCapabilities?.supportsVideoFrames).toBe(true);
    expect(scopedCapabilities?.supportsGatewayControl).toBe(true);
    expect(
      (
        await resolveRealtimeVoiceProviderCapabilitiesAsync({
          provider,
          providerConfig: { authMode: "oauth" },
          model: "gpt-live-1",
          surface: "browser-session",
        })
      )?.supportsGatewayControl,
    ).toBe(false);
  });
});
