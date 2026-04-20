import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { splitMediaFromOutput } from "../media/parse.js";

function extractToolDeliveryMediaUrls(payload: ReplyPayload): {
  audioAsVoice?: boolean;
  mediaUrls: string[];
} {
  const mediaUrls = payload.mediaUrls ?? [];
  const mediaUrl = payload.mediaUrl ? [payload.mediaUrl] : [];
  const parsed = payload.text ? splitMediaFromOutput(payload.text) : undefined;
  const textMediaUrls = parsed?.mediaUrls ?? [];
  const seen = new Set<string>();
  for (const rawUrl of [...mediaUrls, ...mediaUrl, ...textMediaUrls]) {
    const url = rawUrl.trim();
    if (!url || seen.has(url)) {
      continue;
    }
    seen.add(url);
  }
  return {
    audioAsVoice: payload.audioAsVoice ?? parsed?.audioAsVoice,
    mediaUrls: [...seen],
  };
}

export function resolveToolDeliveryPayload(
  payload: ReplyPayload,
  options?: { allowText?: boolean; allowExecApproval?: boolean },
): ReplyPayload | null {
  const allowText = options?.allowText === true;
  const allowExecApproval = options?.allowExecApproval !== false;
  if (allowText && payload.text?.trim()) {
    return payload;
  }
  const execApproval =
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData)
      ? payload.channelData.execApproval
      : undefined;
  if (
    allowExecApproval &&
    execApproval &&
    typeof execApproval === "object" &&
    !Array.isArray(execApproval)
  ) {
    return payload;
  }
  const extracted = extractToolDeliveryMediaUrls(payload);
  const mediaUrls = extracted.mediaUrls;
  if (mediaUrls.length === 0) {
    return null;
  }
  return {
    ...payload,
    text: undefined,
    mediaUrls,
    mediaUrl: mediaUrls[0],
    ...(extracted.audioAsVoice !== undefined ? { audioAsVoice: extracted.audioAsVoice } : {}),
  };
}
