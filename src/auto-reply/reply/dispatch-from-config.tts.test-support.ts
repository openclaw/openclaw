import type { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import type { ReplyPayload } from "../types.js";

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
    if (
      state.synthesizeFinalAudio &&
      params.kind === "final" &&
      typeof params.payload?.text === "string" &&
      params.payload.text.trim()
    ) {
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
