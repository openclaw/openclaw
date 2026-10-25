import { pruneMapToMaxSize } from "../../../src/infra/map-size.ts";

export type FenceMarker = { length: number; marker: "`" | "~"; container: boolean };
const STREAMING_CACHE_LIMIT = 8;

export type StreamingMarkdownSplit = {
  /** End of the stable prefix, outside unfinished block containers. */
  boundary: number;
  /** Absolute offset where remend may start, or null while a fence remains open. */
  tailRepairStart: number | null;
};

export type StreamingMarkdownCursor = {
  boundary: number;
  containerOffset: number | null;
  hasLinkReferenceDefinition: boolean;
  index: number;
  lastLiteralOffset: number;
  lineMode: "fence" | "plain" | null;
  openFence: FenceMarker | null;
};

type StreamingMarkdownCacheEntry = {
  cursor: StreamingMarkdownCursor;
  markdown: string;
  rawTail: boolean;
  result: StreamingMarkdownSplit;
};

type StreamingMarkdownState = {
  input?: { source: string; normalized: string };
  split?: StreamingMarkdownCacheEntry;
  rendered?: { options: string; markdown: string; html: string; hasHtml: boolean };
};
const streamingCache = new Map<string, StreamingMarkdownState>();

export function streamingMarkdownStableHtml(streamKey?: string): string {
  return streamKey ? (streamingCache.get(streamKey)?.rendered?.html ?? "") : "";
}

export function streamingMarkdownState(streamKey?: string): StreamingMarkdownState | undefined {
  if (!streamKey) {
    return undefined;
  }
  const state = streamingCache.get(streamKey) ?? {};
  streamingCache.delete(streamKey);
  streamingCache.set(streamKey, state);
  pruneMapToMaxSize(streamingCache, STREAMING_CACHE_LIMIT);
  return state;
}
