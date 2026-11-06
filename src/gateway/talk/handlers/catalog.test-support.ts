import { beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RealtimeVoiceProviderPlugin } from "../../../plugins/types.js";
import { setActiveDegradedSecretOwners } from "../../../secrets/runtime-degraded-state.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createTalkHandlerCaller } from "./handler-invocation.test-support.js";
import { talkHandlers } from "./index.js";

const mocks = vi.hoisted(() => ({
  isRealtimeVoiceProviderConfiguredAsync: vi.fn(
    async ({
      provider,
      cfg,
      providerConfig,
    }: {
      provider: {
        isConfigured: (ctx: { cfg?: unknown; providerConfig: unknown }) => boolean;
      };
      cfg?: unknown;
      providerConfig: unknown;
    }) => provider.isConfigured({ cfg, providerConfig }),
  ),
  resolveRealtimeVoiceProviderCapabilitiesAsync: vi.fn(
    ({ provider }: { provider: { capabilities?: unknown } }) => provider.capabilities,
  ),
  resolveInternalRealtimeVoiceGatewayRelayLaunchError: vi.fn(),
  cancelInternalRealtimeVoiceBrowserSession: vi.fn(async () => undefined),
  getCanonicalUserPreferences: vi.fn<
    () => Promise<{ profileId: string; entries: Record<string, unknown> } | undefined>
  >(async () => undefined),
  projectConfigOntoRuntimeSourceSnapshot: vi.fn<(config: OpenClawConfig) => OpenClawConfig>(),
  canonicalizeSpeechProviderId: vi.fn((providerId: string | undefined) => providerId),
  getSpeechProvider: vi.fn(),
  listSpeechProviders: vi.fn(() => []),
  synthesizeSpeech: vi.fn(),
  canonicalizeRealtimeVoiceProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "gemini-live" ? "google" : providerId?.trim().toLowerCase(),
  ),
  listRealtimeVoiceProviders: vi.fn<() => RealtimeVoiceProviderPlugin[]>(() => []),
  canonicalizeRealtimeTranscriptionProviderId: vi.fn((providerId: string | undefined) =>
    providerId === "openai-realtime" ? "openai" : providerId?.trim().toLowerCase(),
  ),
  getRealtimeTranscriptionProvider: vi.fn(),
  listRealtimeTranscriptionProviders: vi.fn<
    typeof import("../../../realtime-transcription/provider-registry.js").listRealtimeTranscriptionProviders
  >(() => []),
  resolveConfiguredRealtimeVoiceProviderAsync: vi.fn(),
  resolveSessionKeyFromResolveParams: vi.fn(),
}));

vi.mock("../../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/config.js")>()),
  projectConfigOntoRuntimeSourceSnapshot: mocks.projectConfigOntoRuntimeSourceSnapshot,
}));

vi.mock("../../../state/user-preferences.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-preferences.js")>()),
  getCanonicalUserPreferences: mocks.getCanonicalUserPreferences,
}));

vi.mock("../../../tts/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../tts/provider-registry.js")>()),
  canonicalizeSpeechProviderId: mocks.canonicalizeSpeechProviderId,
  getSpeechProvider: mocks.getSpeechProvider,
  listSpeechProviders: mocks.listSpeechProviders,
}));

// mock-isolation: Keep synthesis stubbed while using real settings/readiness without barrel initialization.
vi.mock("../../../tts/tts.js", async () => ({
  isTtsProviderConfiguredAsync: (await import("../../../tts/tts-provider-resolution.js"))
    .isTtsProviderConfiguredAsync,
  resolveTtsConfig: (await import("../../../tts/tts-settings.js")).resolveTtsConfig,
  synthesizeSpeech: mocks.synthesizeSpeech,
}));

vi.mock("../../../talk/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-registry.js")>()),
  canonicalizeRealtimeVoiceProviderId: mocks.canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider: (providerId: string | undefined) =>
    mocks
      .listRealtimeVoiceProviders()
      .find((provider: { id: string }) => provider.id === providerId),
  listRealtimeVoiceProviders: mocks.listRealtimeVoiceProviders,
}));

vi.mock("../../../realtime-transcription/provider-registry.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../realtime-transcription/provider-registry.js")
  >()),
  canonicalizeRealtimeTranscriptionProviderId: mocks.canonicalizeRealtimeTranscriptionProviderId,
  getRealtimeTranscriptionProvider: mocks.getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders: mocks.listRealtimeTranscriptionProviders,
}));

// mock-isolation: Keep provider registration and credential state outside handler tests.
vi.mock("../../sessions-resolve.js", () => ({
  withPreparedSessionResolve: async (
    { isCurrent: _isCurrent, ...params }: Record<string, unknown>,
    consume: (result: unknown) => unknown,
  ) => consume(mocks.resolveSessionKeyFromResolveParams(params)),
}));

vi.mock("../../../talk/provider-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../talk/provider-resolver.js")>()),
  isRealtimeVoiceProviderConfiguredAsync: mocks.isRealtimeVoiceProviderConfiguredAsync,
  resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveConfiguredRealtimeVoiceProviderAsync,
  resolveRealtimeVoiceProviderCapabilitiesAsync:
    mocks.resolveRealtimeVoiceProviderCapabilitiesAsync,
}));

vi.mock("../../../talk/provider-internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../talk/provider-internal.js")>();
  return {
    ...actual,
    cancelInternalRealtimeVoiceBrowserSession: mocks.cancelInternalRealtimeVoiceBrowserSession,
    resolveInternalRealtimeVoiceGatewayRelayLaunchError:
      mocks.resolveInternalRealtimeVoiceGatewayRelayLaunchError,
  };
});

export function setSourceConfig(config: OpenClawConfig) {
  mocks.projectConfigOntoRuntimeSourceSnapshot.mockReturnValue(config);
}

export const callTalkHandler = createTalkHandlerCaller(talkHandlers);

export async function invokeTalkHandler(
  method: string,
  options: Omit<Parameters<typeof callTalkHandler>[1], "respond" | "params"> & {
    params?: Record<string, unknown>;
  } = {},
) {
  const respond = vi.fn();
  await callTalkHandler(method, { params: {}, ...options, respond });
  return respond;
}

export function realtimeConfig(
  realtime: NonNullable<OpenClawConfig["talk"]>["realtime"],
): OpenClawConfig {
  return { talk: { realtime } };
}

export function voiceCallConfig(config: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { "voice-call": { config } } } };
}

export function voiceModelConfig(primary: string): OpenClawConfig {
  return { agents: { defaults: { voiceModel: { primary } } } };
}

export const readClient = () => ({ connect: { scopes: ["operator.read"] } });
export function markTalkOwnerCold(ownerId: string): void {
  setActiveDegradedSecretOwners([
    {
      ownerKind: "capability",
      ownerId,
      state: "unavailable",
      paths: [],
      refKeys: [],
      reason: "secret reference was not found",
    },
  ]);
}

beforeEach(() => {
  rpcSourceTesting.clear();
  setActiveDegradedSecretOwners([]);
  mocks.getRealtimeTranscriptionProvider.mockImplementation((providerId: string | undefined) => {
    const normalized = providerId?.trim().toLowerCase();
    return mocks
      .listRealtimeTranscriptionProviders()
      .find(
        (provider) =>
          provider.id.toLowerCase() === normalized ||
          provider.aliases?.some((alias) => alias.toLowerCase() === normalized),
      );
  });
});

export { mocks };
