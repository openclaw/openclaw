import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { dispatchReplyFromConfig } from "./dispatch-from-config.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

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
export function shouldSynthesizeFinalAudio(
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

const emptyConfig = {} as OpenClawConfig;

/** One dispatch of a final payload through the qa-channel, returning everything delivered. */
export async function deliverFinalWithMedia(
  payload: ReplyPayload,
): Promise<Array<{ kind: string; payload: ReplyPayload }>> {
  const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
  const dispatcher = createReplyDispatcher({
    deliver: async (deliveredPayload, info) => {
      delivered.push({ kind: info.kind, payload: deliveredPayload });
    },
  });
  await dispatchReplyFromConfig({
    ctx: buildTestCtx({ Provider: "qa-channel", Surface: "qa-channel" }),
    cfg: emptyConfig,
    dispatcher,
    replyResolver: async () => payload,
  });
  dispatcher.markComplete();
  await dispatcher.waitForIdle();
  return delivered;
}
