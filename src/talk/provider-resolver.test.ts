// Talk provider resolver tests cover provider selection from config.
import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { InternalRealtimeVoiceProviderApi } from "./provider-internal.js";
import {
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

  it.each(["isConfiguredAsync"] as const)(
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
    },
  );

  it("preserves the typed availability error when every auto provider is unavailable", async () => {
    class ProviderUnavailableError extends Error {}
    const unavailable = new ProviderUnavailableError("provider owner is unavailable");
    const assertProviderAvailable = vi.fn(() => {
      throw unavailable;
    });

    await expect(
      resolveConfiguredRealtimeVoiceProviderAsync({
        cfg: {},
        providers,
        isProviderAvailable: () => false,
        assertProviderAvailable,
      }),
    ).rejects.toThrow(unavailable);
    expect(assertProviderAvailable).toHaveBeenCalledOnce();
    expect(assertProviderAvailable).toHaveBeenCalledWith(providers[0]);
  });

  it("passes the requested agent scope to explicitly selected provider checks", async () => {
    const isConfigured = vi.fn(() => true);
    const provider: RealtimeVoiceProviderPlugin = {
      id: "agent-scoped",
      label: "Agent scoped",
      isConfigured,
      createBridge: () => {
        throw new Error("unused");
      },
    };

    await resolveConfiguredRealtimeVoiceProviderAsync({
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

  it("keeps browser-only providers out of bridge auto-selection", async () => {
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
      (
        await resolveConfiguredRealtimeVoiceProviderAsync({
          cfg: {},
          providers: [browserOnly, bridge],
        })
      ).provider.id,
    ).toBe("bridge");
    expect(
      (
        await resolveConfiguredRealtimeVoiceProviderAsync({
          cfg: {},
          agentId: "voice-agent",
          providers: [browserOnly, bridge],
          surface: "browser-session",
        })
      ).provider.id,
    ).toBe("browser-only");
    expect(isBrowserSessionConfigured).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "voice-agent" }),
    );
  });

  it("limits internal relay readiness to the gateway-relay surface", async () => {
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

    await expect(
      resolveConfiguredRealtimeVoiceProviderAsync({
        configuredProviderId: "relay-only",
        providers: [relayOnly],
        surface: "bridge",
      }),
    ).rejects.toThrow('Realtime voice provider "relay-only" is not configured');
    expect(
      (
        await resolveConfiguredRealtimeVoiceProviderAsync({
          configuredProviderId: "relay-only",
          providers: [relayOnly],
          surface: "gateway-relay",
        })
      ).provider,
    ).toBe(relayOnly);
  });

  it("applies a default model before provider config resolution", async () => {
    const resolution = await resolveConfiguredRealtimeVoiceProviderAsync({
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
