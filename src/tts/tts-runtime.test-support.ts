import crypto from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, TtsConfig } from "openclaw/plugin-sdk/config-contracts";
import { MAX_TIMER_TIMEOUT_MS as MAX_TIMER_TIMEOUT_MS_CORE } from "openclaw/plugin-sdk/number-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import type {
  SpeechListVoicesRequest,
  SpeechProviderPlugin,
  SpeechProviderPrepareSynthesisContext,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
} from "openclaw/plugin-sdk/speech-core";
import { expect, vi } from "vitest";
import { createRequireRecord } from "../../test/helpers/record.js";
import type { TtsAudioPersistence } from "./tts-synthesis.js";

type MockSpeechSynthesisResult = Awaited<ReturnType<SpeechProviderPlugin["synthesize"]>>;

const {
  synthesizeMock,
  prepareSynthesisMock,
  listSpeechProvidersMock,
  getSpeechProviderMock,
  transcodeAudioBufferMock,
} = vi.hoisted(() => ({
  synthesizeMock: vi.fn(
    async (request: SpeechSynthesisRequest): Promise<MockSpeechSynthesisResult> => ({
      audioBuffer: Buffer.from("voice"),
      fileExtension: ".ogg",
      outputFormat: "ogg",
      voiceCompatible: request.target === "voice-note",
    }),
  ),
  prepareSynthesisMock: vi.fn(async (_ctx: SpeechProviderPrepareSynthesisContext) => undefined),
  listSpeechProvidersMock: vi.fn<(cfg?: OpenClawConfig) => SpeechProviderPlugin[]>(),
  getSpeechProviderMock:
    vi.fn<(providerId: string, cfg?: OpenClawConfig) => SpeechProviderPlugin | null | undefined>(),
  // Keep the real return union so individual cases can enable transcoding.
  transcodeAudioBufferMock: vi.fn<
    () => ReturnType<typeof import("../media/media-services.js").transcodeAudioBuffer>
  >(async () => ({ ok: false, reason: "platform-unsupported" })),
}));

vi.mock("../media/media-services.js", () => ({
  transcodeAudioBuffer: transcodeAudioBufferMock,
}));

vi.mock("../channels/plugins/tts-capabilities.js", () => ({
  normalizeChannelId: (channel: string | undefined) => channel?.trim().toLowerCase() ?? null,
  resolveChannelTtsVoiceDelivery: (channel: string | undefined) => {
    const normalized = channel?.trim().toLowerCase();
    if (normalized === "voice-memo-chat") {
      return {
        synthesisTarget: "audio-file",
        audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
        preferAudioFileFormat: "caf",
      };
    }
    if (normalized === "feishu" || normalized === "whatsapp") {
      return { synthesisTarget: "voice-note", transcodesAudio: true };
    }
    if (normalized === "discord" || normalized === "matrix" || normalized === "telegram") {
      return { synthesisTarget: "voice-note" };
    }
    return undefined;
  },
}));

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/capability-provider-runtime.js")>(
    "../plugins/capability-provider-runtime.js",
  );
  return {
    ...actual,
    resolvePluginCapabilityProvider: ({
      providerId,
      cfg,
    }: Parameters<typeof actual.resolvePluginCapabilityProvider>[0]) =>
      getSpeechProviderMock(providerId, cfg) ?? undefined,
    resolvePluginCapabilityProviders: ({ cfg }: { cfg?: OpenClawConfig }) =>
      listSpeechProvidersMock(cfg),
    preparePluginCapabilityProviderResolution: ({ cfg }: { cfg?: OpenClawConfig }) => ({
      load: undefined,
      resolve: () => listSpeechProvidersMock(cfg),
    }),
    preparePluginCapabilityProviderLookup: ({
      providerId,
      cfg,
    }: Parameters<typeof actual.preparePluginCapabilityProviderLookup>[0]) => ({
      load: undefined,
      resolve: () => getSpeechProviderMock(providerId, cfg) ?? undefined,
    }),
  };
});

installSpeechProviders([createMockSpeechProvider("mock", { label: "Mock" })]);

export const {
  testApi,
  buildTtsSystemPromptHint,
  getTtsPersona,
  getTtsProviderAsync,
  isTtsProviderConfiguredAsync,
  listSpeechVoices,
  resolveTtsConfig,
  setTtsMachinePrefsPathResolver,
  setSummarizationEnabled,
  setTtsMaxLength,
  synthesizeSpeech,
  textToSpeechStream,
  textToSpeechTelephony,
} = await import("./runtime-api.js");
export const { prepareTtsRequest } = await import("./tts-request.js");
export const { maybeApplyTtsToPayloadCore } = await import("./tts-payload.js");
export const { textToSpeechCore } = await import("./tts-synthesis.js");

export const MAX_TIMER_TIMEOUT_MS = MAX_TIMER_TIMEOUT_MS_CORE;
export {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";

export const nativeVoiceNoteChannels = [
  "discord",
  "feishu",
  "matrix",
  "telegram",
  "whatsapp",
] as const;

export function createMockSpeechProvider(
  id = "mock",
  options: Partial<SpeechProviderPlugin> = {},
): SpeechProviderPlugin {
  return {
    id,
    label: id,
    autoSelectOrder: id === "mock" ? 1 : 2,
    isConfigured: () => true,
    prepareSynthesis: prepareSynthesisMock,
    synthesize: synthesizeMock,
    ...options,
  };
}

export function installSpeechProviders(providers: SpeechProviderPlugin[]): void {
  listSpeechProvidersMock.mockImplementation(() => providers);
  getSpeechProviderMock.mockImplementation(
    (providerId: string) => providers.find((provider) => provider.id === providerId) ?? null,
  );
}

export function resetTtsRuntime(): void {
  setTtsMachinePrefsPathResolver();
  clearRuntimeConfigSnapshot();
  delete (Object.prototype as Record<string, unknown>).polluted;
  synthesizeMock.mockClear();
  prepareSynthesisMock.mockClear();
  transcodeAudioBufferMock.mockClear();
  installSpeechProviders([createMockSpeechProvider()]);
}

// macOS os.tmpdir() is a /var -> /private/var symlink and fs-safe rejects
// symlinked store roots; resolve the canonical dir before writing prefs.
const PREFS_TMP_DIR = realpathSync(os.tmpdir());

async function persistTestTtsAudio({
  audioBuffer,
  fileExtension,
}: Parameters<TtsAudioPersistence>[0]): Promise<string> {
  const dir = path.join(PREFS_TMP_DIR, `openclaw-speech-core-media-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const audioPath = path.join(dir, `voice---${crypto.randomUUID()}${fileExtension}`);
  writeFileSync(audioPath, audioBuffer);
  return audioPath;
}

export function textToSpeech(params: Parameters<typeof textToSpeechCore>[0]) {
  return textToSpeechCore(params, persistTestTtsAudio);
}

export function maybeApplyTtsToPayload(params: Parameters<typeof maybeApplyTtsToPayloadCore>[0]) {
  return maybeApplyTtsToPayloadCore(params, persistTestTtsAudio);
}

export async function withTtsPayload(
  params: Parameters<typeof maybeApplyTtsToPayload>[0],
  check: (result: Awaited<ReturnType<typeof maybeApplyTtsToPayload>>) => void | Promise<void>,
) {
  const result = await maybeApplyTtsToPayload(params);
  try {
    await check(result);
  } finally {
    if (result.mediaUrl) {
      rmSync(path.dirname(result.mediaUrl), { recursive: true, force: true });
    }
  }
}

export function prefsPathFor(prefsName: string): string {
  return path.join(PREFS_TMP_DIR, `${prefsName}.json`);
}

export function createTtsConfig(prefsName: string, overrides: TtsConfig = {}): OpenClawConfig {
  setTtsMachinePrefsPathResolver(() => prefsPathFor(prefsName));
  return { tts: { enabled: true, provider: "mock", ...overrides } };
}

export const requireRecord = createRequireRecord("record", "expected-label-record");

export function requireFirstCallParam(calls: ReadonlyArray<readonly unknown[]>, label: string) {
  const call = calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

export function requireFirstSynthesisRequest(label: string): Record<string, unknown> {
  return requireRecord(requireFirstCallParam(synthesizeMock.mock.calls, label), label);
}

export function requireAttempt(attempts: unknown[] | undefined, index: number) {
  if (!attempts) {
    throw new Error("expected synthesis attempts");
  }
  return requireRecord(attempts[index], `synthesis attempt ${index}`);
}

export async function expectTtsPayloadResult(params: {
  channel: string;
  prefsName: string;
  text: string;
  target: "voice-note" | "audio-file";
  audioAsVoice: true | undefined;
  providerResult?: MockSpeechSynthesisResult;
  mediaExtension?: string;
  kind?: "tool" | "block" | "final";
}) {
  if (params.providerResult) {
    synthesizeMock.mockResolvedValueOnce(params.providerResult);
  }
  await withTtsPayload(
    {
      payload: { text: params.text },
      cfg: createTtsConfig(params.prefsName),
      channel: params.channel,
      kind: params.kind ?? "final",
    },
    (result) => {
      expect(synthesizeMock.mock.lastCall?.[0]?.target).toBe(params.target);
      expect(result.audioAsVoice).toBe(params.audioAsVoice);
      expect(result.mediaUrl).toMatch(
        new RegExp(`voice---[a-f0-9-]+\\.${params.mediaExtension ?? "ogg"}$`),
      );
      expect(result.spokenText).toBe(params.text);
      expect(result.ttsSupplement).toEqual({ spokenText: params.text });
      expect((result as { trustedLocalMedia?: boolean }).trustedLocalMedia).toBe(true);
    },
  );
}

export { prepareSynthesisMock, synthesizeMock, transcodeAudioBufferMock };
export type {
  OpenClawConfig,
  ReplyPayload,
  SpeechListVoicesRequest,
  SpeechSynthesisRequest,
  SpeechTelephonySynthesisRequest,
  TtsConfig,
};
