import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { stripMarkdown } from "../line/markdown-to-line.js";
import { parseTtsDirectives, summarizeText } from "../tts/tts-core.js";
import type { ResolvedTtsConfig, TtsDirectiveOverrides } from "../tts/tts.js";
import {
  getExtensionHostTtsMaxLength,
  isExtensionHostTtsSummarizationEnabled,
  resolveExtensionHostTtsAutoMode,
} from "./tts-preferences.js";

export type ExtensionHostTtsPayloadPlan =
  | {
      kind: "skip";
      payload: ReplyPayload;
    }
  | {
      kind: "ready";
      nextPayload: ReplyPayload;
      textForAudio: string;
      wasSummarized: boolean;
      overrides: TtsDirectiveOverrides;
    };

export async function resolveExtensionHostTtsPayloadPlan(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  prefsPath: string;
  kind?: "tool" | "block" | "final";
  inboundAudio?: boolean;
  ttsAuto?: string;
}): Promise<ExtensionHostTtsPayloadPlan> {
  const autoMode = resolveExtensionHostTtsAutoMode({
    config: params.config,
    prefsPath: params.prefsPath,
    sessionAuto: params.ttsAuto,
  });
  if (autoMode === "off") {
    return { kind: "skip", payload: params.payload };
  }

  const text = params.payload.text ?? "";
  const directives = parseTtsDirectives(
    text,
    params.config.modelOverrides,
    params.config.openai.baseUrl,
  );
  if (directives.warnings.length > 0) {
    logVerbose(`TTS: ignored directive overrides (${directives.warnings.join("; ")})`);
  }

  const cleanedText = directives.cleanedText;
  const trimmedCleaned = cleanedText.trim();
  const visibleText = trimmedCleaned.length > 0 ? trimmedCleaned : "";
  const ttsText = directives.ttsText?.trim() || visibleText;

  const nextPayload =
    visibleText === text.trim()
      ? params.payload
      : {
          ...params.payload,
          text: visibleText.length > 0 ? visibleText : undefined,
        };

  if (autoMode === "tagged" && !directives.hasDirective) {
    return { kind: "skip", payload: nextPayload };
  }
  if (autoMode === "inbound" && params.inboundAudio !== true) {
    return { kind: "skip", payload: nextPayload };
  }

  const mode = params.config.mode ?? "final";
  if (mode === "final" && params.kind && params.kind !== "final") {
    return { kind: "skip", payload: nextPayload };
  }

  if (!ttsText.trim()) {
    return { kind: "skip", payload: nextPayload };
  }
  if (params.payload.mediaUrl || (params.payload.mediaUrls?.length ?? 0) > 0) {
    return { kind: "skip", payload: nextPayload };
  }
  if (text.includes("MEDIA:")) {
    return { kind: "skip", payload: nextPayload };
  }
  if (ttsText.trim().length < 10) {
    return { kind: "skip", payload: nextPayload };
  }

  const maxLength = getExtensionHostTtsMaxLength(params.prefsPath);
  let textForAudio = ttsText.trim();
  let wasSummarized = false;

  if (textForAudio.length > maxLength) {
    if (!isExtensionHostTtsSummarizationEnabled(params.prefsPath)) {
      logVerbose(
        `TTS: truncating long text (${textForAudio.length} > ${maxLength}), summarization disabled.`,
      );
      textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
    } else {
      try {
        const summary = await summarizeText({
          text: textForAudio,
          targetLength: maxLength,
          cfg: params.cfg,
          config: params.config,
          timeoutMs: params.config.timeoutMs,
        });
        textForAudio = summary.summary;
        wasSummarized = true;
        if (textForAudio.length > params.config.maxTextLength) {
          logVerbose(
            `TTS: summary exceeded hard limit (${textForAudio.length} > ${params.config.maxTextLength}); truncating.`,
          );
          textForAudio = `${textForAudio.slice(0, params.config.maxTextLength - 3)}...`;
        }
      } catch (err) {
        const error = err as Error;
        logVerbose(`TTS: summarization failed, truncating instead: ${error.message}`);
        textForAudio = `${textForAudio.slice(0, maxLength - 3)}...`;
      }
    }
  }

  textForAudio = stripMarkdown(textForAudio).trim();
  if (textForAudio.length < 10) {
    return { kind: "skip", payload: nextPayload };
  }

  return {
    kind: "ready",
    nextPayload,
    textForAudio,
    wasSummarized,
    overrides: directives.overrides,
  };
}
