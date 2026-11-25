import { expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { InternalRealtimeVoiceProviderApi } from "./provider-internal.js";
import {
  resolveConfiguredRealtimeVoiceProvider as resolveProvider,
  resolveConfiguredRealtimeVoiceProviderAsync as resolveProviderAsync,
  resolveRealtimeVoiceProviderCapabilitiesAsync,
} from "./provider-resolver.js";

const INTERNAL_REALTIME_VOICE_PROVIDER = Symbol.for("openclaw.internal.realtime-voice-provider.v1");

function makeProvider(
  id: string,
  overrides: Partial<RealtimeVoiceProviderPlugin> & {
    internal?: InternalRealtimeVoiceProviderApi;
  } = {},
): RealtimeVoiceProviderPlugin {
  const { internal, ...fields } = overrides;
  const provider = {
    id,
    label: id,
    isConfigured: () => false,
    createBridge: () => {
      throw new Error("unused");
    },
    ...fields,
  };
  if (internal) {
    Object.defineProperty(provider, INTERNAL_REALTIME_VOICE_PROVIDER, {
      configurable: true,
      value: internal,
    });
  }
  return provider;
}

const browserCapabilities = {
  transports: ["webrtc"],
  inputAudioFormats: [],
  outputAudioFormats: [],
} satisfies NonNullable<RealtimeVoiceProviderPlugin["capabilities"]>;
function selected(provider: RealtimeVoiceProviderPlugin) {
  return { configuredProviderId: provider.id, providers: [provider] };
}
const legacyHook = () =>
  vi.fn(() => {
    throw new Error("synchronous credential lookup must not run");
  });

const providers: RealtimeVoiceProviderPlugin[] = [
  makeProvider("first", { autoSelectOrder: 1 }),
  makeProvider("second", {
    autoSelectOrder: 2,
    resolveConfig: ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
    isConfigured: ({ providerConfig }) => providerConfig.enabled === true,
  }),
];

it("awaits async provider hooks in priority order and applies session overrides", async () => {
  const legacy = legacyHook();
  const attempted: string[] = [];
  const asyncProviders: RealtimeVoiceProviderPlugin[] = providers.map((provider) => ({
    ...provider,
    resolveConfig: legacy,
    isConfigured: legacy,
    resolveConfigAsync: async ({ rawConfig }) => ({ ...rawConfig, resolved: true }),
    isConfiguredAsync: async ({ providerConfig }) => {
      attempted.push(provider.id);
      return providerConfig.enabled === true;
    },
  }));

  const resolution = await resolveProviderAsync({
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
  expect(legacy).not.toHaveBeenCalled();
});

it("prefers async browser readiness and capabilities over retained synchronous hooks", async () => {
  const legacy = legacyHook();
  const provider = makeProvider("first", {
    autoSelectOrder: 1,
    isConfigured: legacy,
    internal: {
      isBrowserSessionConfigured: legacy,
      resolveBrowserSessionCapabilities: legacy,
      isBrowserSessionConfiguredAsync: async ({ agentId }) => agentId === "voice-agent",
      resolveBrowserSessionCapabilitiesAsync: async ({ agentId }) => ({
        ...browserCapabilities,
        supportsGatewayControl: agentId === "voice-agent",
      }),
    },
  });

  const resolution = await resolveProviderAsync({
    ...selected(provider),
    agentId: "voice-agent",
    surface: "browser-session",
  });

  expect(resolution.provider).toBe(provider);
  expect(resolution.capabilities?.supportsGatewayControl).toBe(true);
  expect(legacy).not.toHaveBeenCalled();
});

it("propagates async readiness rejection without synchronous fallback", async () => {
  const failure = new Error("credential owner unavailable");
  const legacy = vi.fn(() => true);
  const provider = makeProvider("first", {
    autoSelectOrder: 1,
    resolveConfig: vi.fn(() => ({})),
    isConfigured: legacy,
    isConfiguredAsync: async () => {
      throw failure;
    },
  });

  await expect(resolveProviderAsync(selected(provider))).rejects.toBe(failure);
  expect(legacy).not.toHaveBeenCalled();
});

it("preserves the typed availability error when every auto provider is unavailable", () => {
  class ProviderUnavailableError extends Error {}
  const unavailable = new ProviderUnavailableError("provider owner is unavailable");
  const assertProviderAvailable = vi.fn(() => {
    throw unavailable;
  });

  expect(() =>
    resolveProvider({
      cfg: {},
      providers,
      isProviderAvailable: () => false,
      assertProviderAvailable,
    }),
  ).toThrow(unavailable);
  expect(assertProviderAvailable.mock.calls).toEqual([[providers[0]]]);
});

it("passes the requested agent scope to explicitly selected provider checks", () => {
  const isConfigured = vi.fn(() => true);
  const provider = makeProvider("agent-scoped", { isConfigured });

  resolveProvider({ ...selected(provider), agentId: "voice-agent", cfg: {} });

  expect(isConfigured).toHaveBeenCalledWith({
    agentId: "voice-agent",
    cfg: {},
    providerConfig: {},
  });
});

it("keeps browser-only providers out of bridge auto-selection", () => {
  const isBrowserSessionConfigured = vi.fn(
    ({ agentId }: { agentId?: string }) => agentId === "voice-agent",
  );
  const browserOnly = makeProvider("browser-only", {
    autoSelectOrder: 1,
    internal: { isBrowserSessionConfigured },
  });
  const bridge = makeProvider("bridge", {
    autoSelectOrder: 2,
    isConfigured: () => true,
  });

  const choose = (surface?: "browser-session", agentId?: string) =>
    resolveProvider({ cfg: {}, providers: [browserOnly, bridge], surface, agentId }).provider.id;
  expect(choose()).toBe("bridge");
  expect(choose("browser-session", "voice-agent")).toBe("browser-only");
  expect(isBrowserSessionConfigured).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "voice-agent" }),
  );
});

it("limits internal relay readiness to the gateway-relay surface", () => {
  const relayOnly = makeProvider("relay-only", {
    internal: {
      isBrowserSessionConfigured: () => false,
      isGatewayRelayConfigured: () => true,
    },
  });

  const resolve = (surface: "bridge" | "gateway-relay") =>
    resolveProvider({ ...selected(relayOnly), surface }).provider;
  expect(() => resolve("bridge")).toThrow('Realtime voice provider "relay-only" is not configured');
  expect(resolve("gateway-relay")).toBe(relayOnly);
});

it("applies a default model before provider config resolution", () => {
  const resolution = resolveProvider({
    cfg: {},
    configuredProviderId: "second",
    defaultModel: "gpt-realtime",
    providers,
    providerConfigs: { second: { enabled: true } },
  });

  expect(resolution.providerConfig).toStrictEqual({
    enabled: true,
    model: "gpt-realtime",
    resolved: true,
  });
});

it("resolves config-specific provider capabilities", async () => {
  const provider = makeProvider("dynamic", {
    capabilities: { ...browserCapabilities, supportsVideoFrames: true },
    isConfigured: () => true,
    internal: {
      isBrowserSessionConfigured: () => true,
      isBrowserSessionConfiguredAsync: async () => true,
      resolveBrowserSessionCapabilitiesAsync: async ({ providerConfig, agentId, model }) => ({
        ...browserCapabilities,
        supportsVideoFrames: providerConfig.authMode !== "native" && model === "gpt-live-1",
        supportsGatewayControl: agentId === "molty",
      }),
    },
  });

  const capabilities = (authMode: string, agentId?: string) =>
    resolveRealtimeVoiceProviderCapabilitiesAsync({
      provider,
      providerConfig: { authMode },
      agentId,
      model: "gpt-live-1",
      surface: "browser-session",
    });
  expect((await capabilities("native"))?.supportsVideoFrames).toBe(false);
  const scopedCapabilities = await capabilities("oauth", "molty");
  expect(scopedCapabilities).toMatchObject({
    supportsVideoFrames: true,
    supportsGatewayControl: true,
  });
  expect((await capabilities("oauth"))?.supportsGatewayControl).toBe(false);
});
