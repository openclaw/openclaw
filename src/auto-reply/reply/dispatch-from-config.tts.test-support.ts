import type { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";

// Mirrors the core guards that decide a payload cannot be spoken, so mocked dispatch
// tests see the same silences as production: media (including a legacy MEDIA: line in
// the text) would be overwritten by the audio, and command replies never auto-speak.
function payloadCarriesMedia(payload?: ReplyPayload): boolean {
  if (payload?.mediaUrl || payload?.mediaUrls?.some((mediaUrl) => mediaUrl.trim())) {
    return true;
  }
  return /(?:^|\n)\s*MEDIA\s*:/i.test(payload?.text ?? "");
}

function payloadSuppressesAutoTts(payload?: ReplyPayload): boolean {
  if (!payload) {
    return false;
  }
  // Order matters, and it follows the core: the media guard is unconditional, while
  // an explicit speech request bypasses only the command-reply/auto-mode guard.
  // Letting ttsExplicit skip the media check would mean the mock synthesizes over an
  // attachment that production leaves alone — and the tests could no longer tell a
  // surviving picture from one replaced by audio.
  if (payloadCarriesMedia(payload)) {
    return true;
  }
  const metadata = getReplyPayloadMetadata(payload);
  if (metadata?.ttsExplicit === true) {
    return false;
  }
  return metadata?.commandReply === true;
}

/** The mocked synthesizer speaks a final the way production would: text, and no guard against it. */
function shouldSynthesizeFinalAudio(
  params: { payload: ReplyPayload; kind: "tool" | "block" | "final" },
  synthesizeFinalAudio: boolean,
): boolean {
  return (
    synthesizeFinalAudio &&
    params.kind === "final" &&
    !payloadSuppressesAutoTts(params.payload) &&
    typeof params.payload?.text === "string" &&
    Boolean(params.payload.text.trim())
  );
}

export function createDispatchTtsMocks(mock: Pick<typeof vi, "fn">) {
  const state = {
    synthesizeFinalAudio: false,
    synthesizeToolAudio: false,
    statusSnapshot: {
      autoMode: "always",
      provider: "auto",
      maxLength: 1500,
      summarize: true,
    } as {
      autoMode: TtsAutoMode;
      provider: string;
      maxLength: number;
      summarize: boolean;
    },
  };
  const applyTtsToPayload = async (paramsUnknown: unknown) => {
    const params = paramsUnknown as {
      payload: ReplyPayload;
      kind: "tool" | "block" | "final";
    };
    if (shouldSynthesizeFinalAudio(params, state.synthesizeFinalAudio)) {
      return {
        ...params.payload,
        mediaUrl: "https://example.com/tts-synth.opus",
        audioAsVoice: true,
        trustedLocalMedia: true,
      };
    }
    if (
      state.synthesizeToolAudio &&
      params.kind === "tool" &&
      typeof params.payload?.text === "string" &&
      params.payload.text.trim()
    ) {
      return {
        ...params.payload,
        mediaUrl: "https://example.com/tts-tool.opus",
        audioAsVoice: true,
        trustedLocalMedia: true,
      };
    }
    return params.payload;
  };
  return {
    state,
    applyTtsToPayload,
    maybeApplyTtsToPayload: mock.fn(applyTtsToPayload),
    normalizeTtsAutoMode: mock.fn((value: unknown) =>
      typeof value === "string" ? value : undefined,
    ),
    resolveTtsConfig: mock.fn((_cfg: OpenClawConfig) => ({ mode: "final" })),
  };
}
