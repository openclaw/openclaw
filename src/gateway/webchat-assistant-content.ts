import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { loadWebMedia } from "../web/media.js";

export type AssistantTextContentBlock = {
  type: "text";
  text: string;
};

export type AssistantImageContentBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

export type AssistantContentBlock = AssistantTextContentBlock | AssistantImageContentBlock;

const WEBCHAT_MEDIA_MAX_BYTES = 5_000_000;

export function normalizeMediaUrls(params: { mediaUrl?: unknown; mediaUrls?: unknown }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };

  if (Array.isArray(params.mediaUrls)) {
    for (const entry of params.mediaUrls) {
      push(entry);
    }
  }

  push(params.mediaUrl);

  return out;
}

export function appendAssistantTextBlock(
  blocks: AssistantContentBlock[],
  text: string | undefined,
): void {
  const normalized = text?.trim();
  if (!normalized) {
    return;
  }
  blocks.push({ type: "text", text: normalized });
}

export async function resolveAssistantImageBlocks(params: {
  mediaUrls: string[];
  localRoots: readonly string[];
  logWarn: (message: string) => void;
}): Promise<AssistantImageContentBlock[]> {
  const blocks: AssistantImageContentBlock[] = [];

  for (const mediaUrl of params.mediaUrls) {
    try {
      const media = await loadWebMedia(mediaUrl, {
        maxBytes: WEBCHAT_MEDIA_MAX_BYTES,
        localRoots: params.localRoots,
      });
      if (media.kind !== "image") {
        params.logWarn(`webchat media skipped (not image): ${mediaUrl}`);
        continue;
      }
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: media.contentType ?? "image/png",
          data: media.buffer.toString("base64"),
        },
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      params.logWarn(`webchat media skipped (${mediaUrl}): ${detail}`);
    }
  }

  return blocks;
}

export function resolveWebchatMediaLocalRoots(
  cfg: OpenClawConfig,
  agentId?: string,
): readonly string[] {
  return getAgentScopedMediaLocalRoots(cfg, agentId);
}

export function buildAssistantMessageFromContent(
  blocks: AssistantContentBlock[],
): Record<string, unknown> | undefined {
  if (blocks.length === 0) {
    return undefined;
  }
  return {
    role: "assistant",
    content: blocks,
    timestamp: Date.now(),
  };
}

export async function appendMediaBlocksFromPayload(params: {
  payload: ReplyPayload;
  localRoots: readonly string[];
  seenMediaUrls: Set<string>;
  blocks: AssistantContentBlock[];
  logWarn: (message: string) => void;
}): Promise<void> {
  const mediaUrls = normalizeMediaUrls({
    mediaUrl: params.payload.mediaUrl,
    mediaUrls: params.payload.mediaUrls,
  }).filter((url) => {
    if (params.seenMediaUrls.has(url)) {
      return false;
    }
    params.seenMediaUrls.add(url);
    return true;
  });

  if (mediaUrls.length === 0) {
    return;
  }

  const imageBlocks = await resolveAssistantImageBlocks({
    mediaUrls,
    localRoots: params.localRoots,
    logWarn: params.logWarn,
  });
  params.blocks.push(...imageBlocks);
}
