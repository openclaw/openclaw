import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { MEDIA_MAX_BYTES } from "./store.js";

const MB = 1024 * 1024;
/** Native local audio/video displayed by webchat is streamed, independently of channel caps. */
export const WEBCHAT_LOCAL_MEDIA_MAX_BYTES = 4 * 1024 * MB;
const TELEGRAM_DEFAULT_MEDIA_MAX_MB = 100;
/** Holds an uncompressed 4K (3840x2160) RGBA PNG, the largest output current image models return. */
const GENERATED_IMAGE_DOWNLOAD_MAX_BYTES = 32 * MB;
type GeneratedMediaKind = Extract<MediaKind, "audio" | "image" | "video">;

/** Returns the configured media cap, falling back to the media-core per-kind default. */
export function resolveGeneratedMediaMaxBytes(
  cfg: OpenClawConfig | undefined,
  kind: GeneratedMediaKind,
) {
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured * MB)
    : maxBytesForKind(kind);
}

/**
 * Bounds a provider's download of generated images. Persistence re-encodes oversized images to
 * the media cap, so this guards memory only and never drops below the configured cap.
 */
export function resolveGeneratedImageDownloadMaxBytes(cfg: OpenClawConfig | undefined) {
  return Math.max(resolveGeneratedMediaMaxBytes(cfg, "image"), GENERATED_IMAGE_DOWNLOAD_MAX_BYTES);
}

/** Reads channel/account media caps from raw channel config without requiring typed account schemas. */
export function resolveChannelAccountMediaMaxMb(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): number | undefined {
  const channelId = params.channel?.trim();
  const accountId = params.accountId?.trim();
  const channelCfg = channelId ? params.cfg.channels?.[channelId] : undefined;
  const channelObj = asOptionalObjectRecord(channelCfg);
  const channelMediaMax =
    typeof channelObj?.mediaMaxMb === "number" ? channelObj.mediaMaxMb : undefined;
  const accountsObj = asOptionalObjectRecord(channelObj?.accounts);
  const accountCfg =
    accountId && channelId
      ? asOptionalObjectRecord(
          resolveChannelAccountEntry(accountsObj, accountId, channelId, normalizeAccountId),
        )
      : undefined;
  const accountMediaMax = accountCfg?.mediaMaxMb;
  return (typeof accountMediaMax === "number" ? accountMediaMax : undefined) ?? channelMediaMax;
}

/** Resolves the byte cap for staging an outbound reply's media from its configured channel/account, agent, or Telegram default. */
export function resolveOutboundMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): number {
  const limitMb =
    resolveChannelAccountMediaMaxMb(params) ??
    params.cfg.agents?.defaults?.mediaMaxMb ??
    (params.channel?.trim().toLowerCase() === "telegram"
      ? TELEGRAM_DEFAULT_MEDIA_MAX_MB
      : undefined);
  return typeof limitMb === "number" && Number.isFinite(limitMb) && limitMb > 0
    ? Math.floor(limitMb * MB)
    : MEDIA_MAX_BYTES;
}
