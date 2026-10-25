import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SpeechProviderPlugin } from "../../plugins/types.js";
import { runTtsProviders } from "./tts-runtime.js";

const mocks = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  listSpeechProviders: vi.fn<typeof import("../../tts/provider-registry.js").listSpeechProviders>(
    () => [],
  ),
  resolveProfileKey: vi.fn<
    typeof import("../../plugins/provider-auth-availability.js").resolveProviderAuthProfileApiKey
  >(async () => undefined),
  resolveExecutionAuth: vi.fn(async () => {
    throw new Error("Inventory must not resolve execution auth or refresh OAuth");
  }),
  resolveConfig: vi.fn(async ({ config }: { config: OpenClawConfig; mode?: string }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  })),
  callGateway: vi.fn(),
}));

// mock-isolation: Supply command config without reading operator files or publishing runtime state.
vi.mock("../../config/config.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => mocks.config,
  getRuntimeConfigSourceSnapshot: () => null,
  setRuntimeConfigSnapshot: vi.fn(),
}));

// mock-isolation: Keep fixture agent directories independent from machine auth directories.
vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: (_cfg: OpenClawConfig, agentId: string) => `/synthetic/agent-${agentId}`,
}));

// mock-isolation: Inventory owns no real database or persisted auth in this projection test.
vi.mock("../../agents/auth-profiles.js", () => ({
  withAuthProfileStoreAgentDir: (_dir: string, _state: string, run: () => unknown) => run(),
  loadAuthProfileStoreForRuntime: () => ({ version: 1, profiles: {} }),
  listProfilesForProvider: () => [],
}));

// mock-isolation: An execution-auth lookup is a forbidden side effect of provider inventory.
vi.mock("../../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore: mocks.resolveExecutionAuth,
}));

// mock-isolation: Supply saved API-key material without opening or refreshing credential stores.
vi.mock("../../plugins/provider-auth-availability.js", () => ({
  resolveProviderAuthProfileApiKey: mocks.resolveProfileKey,
}));

// mock-isolation: Native provider fixtures replace plugin discovery, not configured evaluation.
vi.mock("../../tts/provider-registry.js", () => ({
  listSpeechProviders: mocks.listSpeechProviders,
  getSpeechProvider: (providerId: string) =>
    mocks.listSpeechProviders().find((provider) => provider.id === providerId),
  canonicalizeSpeechProviderId: (provider: string) => provider,
  normalizeSpeechProviderId: (provider?: string) => provider?.trim().toLowerCase() || undefined,
}));

// mock-isolation: Use real config/configured owners while avoiding machine preferences and synthesis.
vi.mock("../../tts/tts.js", async () => {
  const { isTtsProviderConfiguredAsync } = await import("../../tts/tts-provider-resolution.js");
  const { resolveTtsConfig } = await import("../../tts/tts-settings.js");
  return {
    isTtsProviderConfiguredAsync,
    resolveTtsConfig,
    resolveTtsPrefsPathAsync: async () => "/synthetic/tts-preferences",
    getTtsProviderAsync: async () => mocks.config.tts?.provider ?? "openai",
  };
});

// mock-isolation: Supply resolved/degraded command config without a real secrets service.
vi.mock("../command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveConfig,
}));

// mock-isolation: Limit this fixture to the TTS credential surface without loading plugin targets.
vi.mock("../command-secret-targets.js", () => ({
  getTtsCommandSecretTargetIds: () => new Set(["tts.providers.*.apiKey"]),
}));

// mock-isolation: Saved account SecretRef preparation has separate ownership tests and live CLI proof.
vi.mock("./local-account-secrets.js", () => ({
  prepareLocalCapabilityAccountSecrets: vi.fn(async () => {}),
}));

// mock-isolation: Supply native Gateway inventory facts without a WebSocket or live daemon.
vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));

// mock-isolation: Conversion-only connection metadata must not initialize Gateway client state.
vi.mock("../../gateway/connection-details.js", () => ({
  buildGatewayConnectionDetailsWithResolvers: vi.fn(),
}));

function speechProvider(id: string): SpeechProviderPlugin {
  const isConfigured: SpeechProviderPlugin["isConfigured"] = ({ providerConfig }) =>
    (typeof providerConfig.apiKey === "string" && Boolean(providerConfig.apiKey.trim())) ||
    Boolean(process.env[`${id.toUpperCase()}_API_KEY`]?.trim());
  return {
    id,
    label: id,
    models: [],
    voices: [],
    isConfigured,
    isConfiguredAsync: async (context) => isConfigured(context),
    synthesize: async () => {
      throw new Error("Inventory must not synthesize speech");
    },
  };
}

describe("TTS provider inventory", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    vi.stubEnv("XAI_API_KEY", "");
    mocks.config = {
      agents: {
        entries: { main: {}, proof: {} },
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
      },
      tts: { provider: "elevenlabs" },
    };
    mocks.listSpeechProviders.mockReturnValue([speechProvider("elevenlabs")]);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps a selected TTS provider unconfigured without credentials", async () => {
    expect(await runTtsProviders("local", "main")).toMatchObject({
      active: "elevenlabs",
      providers: [{ id: "elevenlabs", configured: false, selected: true, available: true }],
    });
  });

  it("marks env-backed TTS providers as configured independently from selection", async () => {
    vi.stubEnv("XAI_API_KEY", "synthetic-xai-key");
    mocks.listSpeechProviders.mockReturnValue([speechProvider("xai")]);

    expect(await runTtsProviders("local", "main")).toMatchObject({
      providers: [{ id: "xai", configured: true, selected: false }],
    });
    expect(mocks.resolveProfileKey).not.toHaveBeenCalled();
  });

  it("keeps voice settings separate from credential availability", async () => {
    mocks.config.tts = { providers: { elevenlabs: { voiceId: "synthetic-voice" } } };

    expect(await runTtsProviders("local", "main")).toMatchObject({
      providers: [{ id: "elevenlabs", configured: false, selected: false }],
    });
  });

  it("keeps saved API keys scoped to the inspected agent without refreshing auth", async () => {
    mocks.resolveProfileKey.mockImplementation(async ({ agentDir }) =>
      agentDir === "/synthetic/agent-proof" ? "synthetic-proof-key" : undefined,
    );

    expect(await runTtsProviders("local", "main")).toMatchObject({
      providers: [{ id: "elevenlabs", configured: false, selected: true }],
    });
    expect(await runTtsProviders("local", "proof")).toMatchObject({
      providers: [{ id: "elevenlabs", configured: true, selected: true }],
    });
    expect(mocks.resolveExecutionAuth).not.toHaveBeenCalled();
    expect(mocks.resolveProfileKey).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: "/synthetic/agent-proof", profileTypes: ["api_key"] }),
    );
  });

  it("inspects credentials after command SecretRefs are materialized", async () => {
    mocks.config.tts = {
      providers: { elevenlabs: { apiKey: { source: "env", provider: "default", id: "TTS_KEY" } } },
    };
    const resolved = {
      ...mocks.config,
      tts: { providers: { elevenlabs: { apiKey: "synthetic-resolved-key" } } },
    };
    mocks.resolveConfig.mockResolvedValueOnce({
      resolvedConfig: resolved,
      effectiveConfig: resolved,
      diagnostics: [],
    });

    expect(await runTtsProviders("local", "main")).toMatchObject({
      providers: [{ id: "elevenlabs", configured: true }],
    });
  });

  it("reports unavailable SecretRefs without aborting or borrowing another credential", async () => {
    mocks.config.tts = {
      provider: "elevenlabs",
      providers: {
        elevenlabs: { apiKey: { source: "env", provider: "default", id: "MISSING_KEY" } },
      },
    };
    const unresolved = {
      ...mocks.config,
      tts: { provider: "elevenlabs", providers: { elevenlabs: { apiKey: undefined } } },
    };
    mocks.resolveConfig.mockImplementationOnce(async ({ mode }) => {
      if (mode !== "read_only_status") {
        throw new Error("TTS inspection must retain read-only SecretRef diagnostics");
      }
      return { resolvedConfig: unresolved, effectiveConfig: unresolved, diagnostics: [] };
    });
    mocks.resolveProfileKey.mockResolvedValueOnce("synthetic-fallback-key");

    expect(await runTtsProviders("local", "main")).toMatchObject({
      providers: [{ id: "elevenlabs", configured: false, selected: true }],
    });
    expect(mocks.resolveProfileKey).not.toHaveBeenCalled();
  });

  it("preserves native Gateway configured facts", async () => {
    mocks.callGateway.mockResolvedValueOnce({
      active: "elevenlabs",
      providers: [{ id: "elevenlabs", configured: false }],
    });

    expect(await runTtsProviders("gateway")).toMatchObject({
      active: "elevenlabs",
      providers: [{ id: "elevenlabs", configured: false, selected: true, available: true }],
    });
    expect(mocks.resolveProfileKey).not.toHaveBeenCalled();
  });
});
