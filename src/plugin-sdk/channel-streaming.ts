import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelStreamingProgressConfig,
  ChannelStreamingConfig,
  SlackChannelStreamingConfig,
  StreamingMode,
  TextChunkMode,
} from "../config/types.base.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export type {
  ChannelDeliveryStreamingConfig,
  ChannelPreviewStreamingConfig,
  ChannelStreamingBlockConfig,
  ChannelStreamingConfig,
  ChannelStreamingProgressConfig,
  ChannelStreamingPreviewConfig,
  SlackChannelStreamingConfig,
  StreamingMode,
  TextChunkMode,
} from "../config/types.base.js";

type StreamingCompatEntry = {
  streaming?: unknown;
  streamMode?: unknown;
  chunkMode?: unknown;
  blockStreaming?: unknown;
  draftChunk?: unknown;
  blockStreamingCoalesce?: unknown;
  nativeStreaming?: unknown;
};

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTextChunkMode(value: unknown): TextChunkMode | undefined {
  return value === "length" || value === "newline" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function normalizeStreamingMode(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized || null;
}

function parsePreviewStreamingMode(value: unknown): StreamingMode | null {
  const normalized = normalizeStreamingMode(value);
  if (
    normalized === "off" ||
    normalized === "partial" ||
    normalized === "block" ||
    normalized === "progress"
  ) {
    return normalized;
  }
  return null;
}

function asBlockStreamingCoalesceConfig(value: unknown): BlockStreamingCoalesceConfig | undefined {
  return asObjectRecord(value) as BlockStreamingCoalesceConfig | undefined;
}

function asBlockStreamingChunkConfig(value: unknown): BlockStreamingChunkConfig | undefined {
  return asObjectRecord(value) as BlockStreamingChunkConfig | undefined;
}

function asProgressConfig(value: unknown): ChannelStreamingProgressConfig | undefined {
  return asObjectRecord(value) as ChannelStreamingProgressConfig | undefined;
}

export const DEFAULT_PROGRESS_DRAFT_LABELS = [
  "Thinking",
  "Shelling",
  "Scuttling",
  "Clawing",
  "Pinching",
  "Molting",
  "Bubbling",
  "Tiding",
  "Reefing",
  "Cracking",
  "Sifting",
  "Brining",
  "Nautiling",
  "Krilling",
  "Barnacling",
  "Lobstering",
  "Tidepooling",
  "Pearling",
  "Snapping",
  "Surfacing",
] as const;

export function getChannelStreamingConfigObject(
  entry: StreamingCompatEntry | null | undefined,
): ChannelStreamingConfig | undefined {
  const streaming = asObjectRecord(entry?.streaming);
  return streaming ? (streaming as ChannelStreamingConfig) : undefined;
}

export function resolveChannelStreamingChunkMode(
  entry: StreamingCompatEntry | null | undefined,
): TextChunkMode | undefined {
  return (
    asTextChunkMode(getChannelStreamingConfigObject(entry)?.chunkMode) ??
    asTextChunkMode(entry?.chunkMode)
  );
}

export function resolveChannelStreamingBlockEnabled(
  entry: StreamingCompatEntry | null | undefined,
): boolean | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return asBoolean(config?.block?.enabled) ?? asBoolean(entry?.blockStreaming);
}

export function resolveChannelStreamingBlockCoalesce(
  entry: StreamingCompatEntry | null | undefined,
): BlockStreamingCoalesceConfig | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return (
    asBlockStreamingCoalesceConfig(config?.block?.coalesce) ??
    asBlockStreamingCoalesceConfig(entry?.blockStreamingCoalesce)
  );
}

export function resolveChannelStreamingPreviewChunk(
  entry: StreamingCompatEntry | null | undefined,
): BlockStreamingChunkConfig | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return (
    asBlockStreamingChunkConfig(config?.preview?.chunk) ??
    asBlockStreamingChunkConfig(entry?.draftChunk)
  );
}

export function resolveChannelStreamingPreviewToolProgress(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = true,
): boolean {
  const config = getChannelStreamingConfigObject(entry);
  return (
    asBoolean(config?.progress?.toolProgress) ??
    asBoolean(config?.preview?.toolProgress) ??
    defaultValue
  );
}

export function resolveChannelStreamingSuppressDefaultToolProgressMessages(
  entry: StreamingCompatEntry | null | undefined,
  options?: {
    draftStreamActive?: boolean;
    previewToolProgressEnabled?: boolean;
    previewStreamingEnabled?: boolean;
  },
): boolean {
  if (options?.draftStreamActive === false || options?.previewStreamingEnabled === false) {
    return false;
  }
  const mode = resolveChannelPreviewStreamMode(entry, "off");
  if (mode === "off") {
    return false;
  }
  if (mode === "progress") {
    return true;
  }
  return options?.previewToolProgressEnabled ?? resolveChannelStreamingPreviewToolProgress(entry);
}

export function resolveChannelStreamingNativeTransport(
  entry: StreamingCompatEntry | null | undefined,
): boolean | undefined {
  const config = getChannelStreamingConfigObject(entry);
  return asBoolean(config?.nativeTransport) ?? asBoolean(entry?.nativeStreaming);
}

export function resolveChannelPreviewStreamMode(
  entry: StreamingCompatEntry | null | undefined,
  defaultMode: "off" | "partial",
): StreamingMode {
  const parsedStreaming = parsePreviewStreamingMode(
    getChannelStreamingConfigObject(entry)?.mode ?? entry?.streaming,
  );
  if (parsedStreaming) {
    return parsedStreaming;
  }

  const legacy = parsePreviewStreamingMode(entry?.streamMode);
  if (legacy) {
    return legacy;
  }
  if (typeof entry?.streaming === "boolean") {
    return entry.streaming ? "partial" : "off";
  }
  return defaultMode;
}

export function resolveChannelProgressDraftConfig(
  entry: StreamingCompatEntry | null | undefined,
): ChannelStreamingProgressConfig {
  return asProgressConfig(getChannelStreamingConfigObject(entry)?.progress) ?? {};
}

function normalizeProgressLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [...DEFAULT_PROGRESS_DRAFT_LABELS];
  }
  const normalized = labels
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : [...DEFAULT_PROGRESS_DRAFT_LABELS];
}

function hashProgressSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function resolveChannelProgressDraftLabel(params: {
  entry?: StreamingCompatEntry | null;
  seed?: string;
  random?: () => number;
}): string | undefined {
  const progress = resolveChannelProgressDraftConfig(params.entry);
  if (progress.label === false) {
    return undefined;
  }
  if (typeof progress.label === "string" && progress.label.trim() && progress.label !== "auto") {
    return progress.label.trim();
  }
  const labels = normalizeProgressLabels(progress.labels);
  const index =
    typeof params.seed === "string" && params.seed.length > 0
      ? hashProgressSeed(params.seed) % labels.length
      : Math.floor(Math.max(0, Math.min(0.999999, params.random?.() ?? 0)) * labels.length);
  return labels[index] ?? labels[0];
}

export function resolveChannelProgressDraftMaxLines(
  entry: StreamingCompatEntry | null | undefined,
  defaultValue = 8,
): number {
  const configured = asInteger(resolveChannelProgressDraftConfig(entry).maxLines);
  return configured && configured > 0 ? configured : defaultValue;
}

export function formatChannelProgressDraftText(params: {
  entry?: StreamingCompatEntry | null;
  lines: string[];
  seed?: string;
  random?: () => number;
  formatLine?: (line: string) => string;
  bullet?: string;
}): string {
  const label = resolveChannelProgressDraftLabel({
    entry: params.entry,
    seed: params.seed,
    random: params.random,
  });
  const maxLines = resolveChannelProgressDraftMaxLines(params.entry);
  const formatLine = params.formatLine ?? ((line: string) => line);
  const bullet = params.bullet ?? "•";
  const lines = params.lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .slice(-maxLines)
    .map((line) => `${bullet} ${formatLine(line)}`);
  return [label, ...lines].filter((line): line is string => Boolean(line)).join("\n");
}
