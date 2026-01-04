import {
  type ElevatedLevel,
  normalizeElevatedLevel,
  normalizeThinkLevel,
  normalizeVerboseLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";

export function extractThinkDirective(body?: string): {
  cleaned: string;
  thinkLevel?: ThinkLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  // Match the longest keyword first to avoid partial captures (e.g. "/think:high")
  const match = body.match(
    /(?:^|\s)\/(?:thinking|think|t)\s*:?\s*([a-zA-Z-]+)\b/i,
  );
  const thinkLevel = normalizeThinkLevel(match?.[1]);
  const cleaned = match
    ? body.replace(match[0], "").replace(/\s+/g, " ").trim()
    : body.trim();
  return {
    cleaned,
    thinkLevel,
    rawLevel: match?.[1],
    hasDirective: !!match,
  };
}

export function extractVerboseDirective(body?: string): {
  cleaned: string;
  verboseLevel?: VerboseLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const match = body.match(
    /(?:^|\s)\/(?:verbose|v)(?=$|\s|:)\s*:?\s*([a-zA-Z-]+)\b/i,
  );
  const verboseLevel = normalizeVerboseLevel(match?.[1]);
  const cleaned = match
    ? body.replace(match[0], "").replace(/\s+/g, " ").trim()
    : body.trim();
  return {
    cleaned,
    verboseLevel,
    rawLevel: match?.[1],
    hasDirective: !!match,
  };
}

export function extractElevatedDirective(body?: string): {
  cleaned: string;
  elevatedLevel?: ElevatedLevel;
  rawLevel?: string;
  hasDirective: boolean;
} {
  if (!body) return { cleaned: "", hasDirective: false };
  const match = body.match(
    /(?:^|\s)\/(?:elevated|elev)(?=$|\s|:)\s*:?\s*([a-zA-Z-]+)\b/i,
  );
  const elevatedLevel = normalizeElevatedLevel(match?.[1]);
  const cleaned = match
    ? body.replace(match[0], "").replace(/\s+/g, " ").trim()
    : body.trim();
  return {
    cleaned,
    elevatedLevel,
    rawLevel: match?.[1],
    hasDirective: !!match,
  };
}

export type { ElevatedLevel, ThinkLevel, VerboseLevel };
