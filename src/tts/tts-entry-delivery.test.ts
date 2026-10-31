import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { testApi } from "openclaw/plugin-sdk/tts-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTtsTool } from "../agents/tools/tts-tool.js";
import { handleTtsCommands } from "../auto-reply/reply/commands-tts.js";
import { buildCommandTestParams } from "../auto-reply/reply/commands.test-harness.js";
import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";
import type { ChannelTtsVoiceDeliveryCapabilities } from "../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { listSpeechProviders } from "./provider-registry.js";
import { maybeApplyTtsToPayload, textToSpeech } from "./tts.js";

// Constructed Ogg/Opus metadata fixture; no provider or decoder has been run.
// One synthetic silence packet; use external decoder proof before claiming playable audio.
const SYNTHETIC_OGG_OPUS = Buffer.from(
  "T2dnUwACAAAAAAAAAAAxU1RUAAAAAHiu4UMBE09wdXNIZWFkAQEAAIC7AAAAAABPZ2dTAAAAAAAAAAAAADFTVFQBAAAAB6hLcAE3T3B1c1RhZ3MnAAAAT3BlbkNsYXcgc3ludGhldGljIFRUUyBtZXRhZGF0YSBmaXh0dXJlAAAAAE9nZ1MABMADAAAAAAAAMVNUVAIAAADuHqTAAQP4//4=",
  "base64",
);
const SYNTHETIC_OGG_OPUS_SHA256 =
  "08bf258f524277fa0b07e6334ebffb1eb600871d8d86ae3db139c2b968ddfb27";

const converter = vi.hoisted(() => ({ count: 0 }));

vi.mock("../media/audio-transcode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/audio-transcode.js")>();
  return {
    ...actual,
    transcodeAudioBuffer: async (params: Parameters<typeof actual.transcodeAudioBuffer>[0]) => {
      converter.count++;
      if (params.sourceExtension !== "ogg" || params.targetExtension !== "caf") {
        throw new Error("Unexpected conversion in the TTS metadata fixture");
      }
      // On macOS this is an explicit converter-failure fixture, not host capability proof.
      // Other platforms execute the real early platform-unsupported path without a subprocess.
      return process.platform === "darwin"
        ? {
            ok: false as const,
            reason: "transcoder-failed" as const,
            detail: "synthetic unavailable converter",
          }
        : actual.transcodeAudioBuffer(params);
    },
  };
});

const PROVIDER = "synthetic-tts-metadata";
const CHANNEL = "imessage";
const SPOKEN = "This synthetic audio should keep its channel delivery decision.";
const requests: string[] = [];
let state: OpenClawTestState;
let cfg: OpenClawConfig;

function installFixture(voice: ChannelTtsVoiceDeliveryCapabilities, compatible = true): void {
  const provider: SpeechProviderPlugin = {
    id: PROVIDER,
    label: "Synthetic TTS metadata fixture",
    isConfigured: () => true,
    synthesize: async (request) => {
      requests.push(request.target);
      return {
        audioBuffer: await fs.readFile(state.path("provider.ogg")),
        fileExtension: ".ogg",
        outputFormat: "ogg-24khz-16bit-mono-opus",
        voiceCompatible: compatible,
      };
    },
  };
  const registry = createTestRegistry([
    {
      pluginId: CHANNEL,
      source: "synthetic-tts-metadata-fixture",
      plugin: createChannelTestPluginBase({
        id: CHANNEL,
        capabilities: { chatTypes: ["direct"], media: true, tts: { voice } },
      }),
    },
  ]);
  registry.speechProviders.push({ pluginId: PROVIDER, source: "synthetic", provider });
  setActivePluginRegistry(registry);
  expect(listSpeechProviders(cfg).map((entry) => entry.id)).toEqual([PROVIDER]);
  expect(resolveChannelTtsVoiceDelivery(CHANNEL)).toEqual(voice);
}

const fileDelivery: ChannelTtsVoiceDeliveryCapabilities = {
  synthesisTarget: "audio-file",
  audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
  preferAudioFileFormat: "caf",
};

async function assertStoredAudio(filePath: unknown): Promise<void> {
  if (typeof filePath !== "string") {
    throw new Error("Expected an actual persisted audio path");
  }
  expect(path.dirname(filePath)).toBe(state.statePath("media", "tool-speech-synthesis"));
  const buffer = await fs.readFile(filePath);
  expect(crypto.createHash("sha256").update(buffer).digest("hex")).toBe(SYNTHETIC_OGG_OPUS_SHA256);
  expect(await detectMime({ buffer, filePath })).toBe("audio/ogg");
  // The canonical media store preserves the supplied audio/ogg header extension.
  expect(path.extname(filePath)).toBe(".ogg");
}

async function observeEntries(expectedVoice: boolean): Promise<void> {
  const core = await textToSpeech({ text: SPOKEN, cfg, channel: CHANNEL, disableFallback: true });
  expect(core).toMatchObject({ success: true, audioAsVoice: expectedVoice, provider: PROVIDER });
  expect(core.voiceCompatible).toBe(!expectedVoice);
  await assertStoredAudio(core.audioPath);

  const tool = createTtsTool({ config: cfg, agentChannel: CHANNEL });
  const result = await tool.execute("synthetic-tts", { text: SPOKEN });
  const media = asRecord(asRecord(result.details)?.media);
  await assertStoredAudio(media?.mediaUrl);

  const params = buildCommandTestParams(
    "/tts audio " + SPOKEN,
    cfg,
    { Provider: CHANNEL, Surface: CHANNEL },
    { workspaceDir: state.workspaceDir },
  );
  params.command.isAuthorizedSender = true;
  const command = await handleTtsCommands(params, true);
  expect(command?.shouldContinue).toBe(false);
  await assertStoredAudio(command?.reply?.mediaUrl);

  const automatic = await maybeApplyTtsToPayload({
    payload: { text: SPOKEN },
    cfg,
    channel: CHANNEL,
    kind: "final",
  });
  await assertStoredAudio(automatic.mediaUrl);

  expect(requests).toHaveLength(4);
  expect.soft(media?.audioAsVoice === true, "tool preserves core decision").toBe(expectedVoice);
  expect
    .soft(command?.reply?.audioAsVoice === true, "/tts audio preserves core decision")
    .toBe(expectedVoice);
  expect
    .soft(automatic.audioAsVoice === true, "automatic sibling preserves core decision")
    .toBe(expectedVoice);
}

describe("TTS real synthesis owner to public output entries", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "home",
      prefix: "openclaw-tts-entry-proof-",
    });
    vi.stubEnv("OPENCLAW_TTS_PREFS", state.path("tts-prefs.json"));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Network is forbidden in the TTS metadata fixture");
      }),
    );
    cfg = { tts: { auto: "always", provider: PROVIDER } };
    await fs.writeFile(state.path("provider.ogg"), SYNTHETIC_OGG_OPUS);
    requests.length = 0;
    converter.count = 0;
  });

  afterEach(async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it.each([false, true])(
    "preserves all entry-point delivery decisions (voice: %s)",
    async (voice) => {
      installFixture(
        voice ? { synthesisTarget: "voice-note", transcodesAudio: true } : fileDelivery,
        !voice,
      );
      expect(testApi.supportsNativeVoiceNoteTts(CHANNEL)).toBe(true);
      expect(testApi.supportsNativeVoiceNoteTts(CHANNEL.toUpperCase())).toBe(true);
      expect(testApi.supportsNativeVoiceNoteTts("slack")).toBe(false);
      expect(testApi.supportsNativeVoiceNoteTts(undefined)).toBe(false);
      await observeEntries(voice);
      expect(requests).toEqual(Array(4).fill(voice ? "voice-note" : "audio-file"));
      expect(converter.count).toBe(voice ? 0 : 4);
    },
  );

  it("preserves a separate explicit automatic-payload voice request", async () => {
    // The audio-file row above is the negative control for this explicit request.
    installFixture(fileDelivery);
    const automatic = await maybeApplyTtsToPayload({
      payload: { text: SPOKEN, audioAsVoice: true },
      cfg,
      channel: CHANNEL,
      kind: "final",
    });
    await assertStoredAudio(automatic.mediaUrl);
    expect(automatic.audioAsVoice).toBe(true);
  });
});
