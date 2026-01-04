import type { ClawdbotConfig } from "../../config/config.js";
import { resolveTextChunkLimit, type TextChunkSurface } from "../chunk.js";

const DEFAULT_BLOCK_STREAM_MIN = 800;
const DEFAULT_BLOCK_STREAM_MAX = 1200;

const BLOCK_CHUNK_SURFACES = new Set<TextChunkSurface>([
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "webchat",
]);

function normalizeChunkSurface(surface?: string): TextChunkSurface | undefined {
  if (!surface) return undefined;
  const cleaned = surface.trim().toLowerCase();
  return BLOCK_CHUNK_SURFACES.has(cleaned as TextChunkSurface)
    ? (cleaned as TextChunkSurface)
    : undefined;
}

export function resolveBlockStreamingChunking(
  cfg: ClawdbotConfig | undefined,
  surface?: string,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const surfaceKey = normalizeChunkSurface(surface);
  const textLimit = resolveTextChunkLimit(cfg, surfaceKey);
  const chunkCfg = cfg?.agent?.blockStreamingChunk;
  const maxRequested = Math.max(
    1,
    Math.floor(chunkCfg?.maxChars ?? DEFAULT_BLOCK_STREAM_MAX),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(
    1,
    Math.floor(chunkCfg?.minChars ?? DEFAULT_BLOCK_STREAM_MIN),
  );
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    chunkCfg?.breakPreference === "newline" ||
    chunkCfg?.breakPreference === "sentence"
      ? chunkCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}
