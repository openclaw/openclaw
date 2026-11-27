import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { truncateUtf16Safe } from "../utils.js";
import { summarizeText } from "./tts-core.js";
import type { ResolvedTtsConfig } from "./tts-settings.js";

/** Summarizes or truncates text over the speech length limit, as auto-TTS does for replies. */
export async function fitTtsTextToLimit(params: {
  text: string;
  maxLength: number;
  summarize: boolean;
  cfg: OpenClawConfig;
  config: ResolvedTtsConfig;
  agentId?: string;
}): Promise<{ text: string; summarized: boolean }> {
  const { text, summarize, cfg, config } = params;
  // Synthesis rejects text over config.maxTextLength, so never prepare more than that.
  const maxLength = Math.min(params.maxLength, config.maxTextLength);
  if (text.length <= maxLength) {
    return { text, summarized: false };
  }
  if (!summarize) {
    logVerbose(
      `TTS: truncating long text (${text.length} > ${maxLength}), summarization disabled.`,
    );
    return { text: `${truncateUtf16Safe(text, maxLength - 3)}...`, summarized: false };
  }
  try {
    const summary = await summarizeText({
      text,
      targetLength: maxLength,
      cfg,
      config,
      timeoutMs: config.timeoutMs,
      agentId: params.agentId,
    });
    if (summary.summary.length > config.maxTextLength) {
      logVerbose(
        `TTS: summary exceeded hard limit (${summary.summary.length} > ${config.maxTextLength}); truncating.`,
      );
      return {
        text: `${truncateUtf16Safe(summary.summary, config.maxTextLength - 3)}...`,
        summarized: true,
      };
    }
    return { text: summary.summary, summarized: true };
  } catch {
    logVerbose("TTS: summarization failed, truncating instead.");
    return { text: `${truncateUtf16Safe(text, maxLength - 3)}...`, summarized: false };
  }
}
