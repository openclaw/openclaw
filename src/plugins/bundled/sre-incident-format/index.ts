import { logVerbose } from "../../../globals.js";
import { isSreIncidentChannelId } from "../../../slack/monitor/incident-channels.js";
import { stripSlackIncidentAllowedPrefixes } from "../../../slack/monitor/incident-format.js";
import type { OpenClawPluginDefinition } from "../../types.js";

export const SRE_INCIDENT_FORMAT_PLUGIN_ID = "sre-incident-format";
const PROGRESS_ONLY_EXACT_LINES = [
  "on it",
  "found it",
  "ok",
  "okay",
  "wait",
  "there are stale changes",
  "the commit was created",
  "pr is created",
  "now i see some issues",
  "the code looks correct here",
];
const PROCEDURAL_PROGRESS_PREFIXES = ["checking", "let me verify", "let me", "i need to"];
const SUBSTANTIVE_PROGRESS_SUFFIX_RE =
  /\b(?:because|caused by|show(?:ed|s|ing)?|revealed?|found|confirm(?:ed|s)?|root cause|mitigation|impact|deployed)\b/i;
const MAX_LABELED_PROGRESS_WORDS = 4;
const ANGLE_BRACKET_METADATA_LINE_RE = /^<[^>\n]+>$/;
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PROGRESS_ONLY_EXACT_LINE_RES = PROGRESS_ONLY_EXACT_LINES.map(
  (line) => new RegExp(`^(?:now\\s+)?${escapeRegex(line)}[.!]?$`, "i"),
);
const PROCEDURAL_PROGRESS_PREFIX_RES = PROCEDURAL_PROGRESS_PREFIXES.map(
  (prefix) => new RegExp(`^(?:now\\s+)?${escapeRegex(prefix)}\\b`, "i"),
);
const DASHED_PROGRESS_PREFIX_RES = [/^(?:ok(?:ay)?|wait)\s+[-–—]\s+(?:i|we|this|that)\b/i];
const GOOD_DASHED_PROGRESS_PREFIX_RE = /^good\s+[-–—]\s+i\s+(?:found|see|noticed)\b/i;
const FIRST_PERSON_PROGRESS_PREFIX_RE =
  /^(?:now\s+)?i(?:'m| am)\s+(?:going to|checking|looking into|pulling|writing|about to)\b/i;
const SUMMARY_LABEL_RE = /^(?:\*[^*\n]+:\*|_[^_\n]+:_)/;
const SUMMARY_BLOCK_RE = /^(?:#{1,6}\s+|[-*](?:\s+|$)|\d+\.(?:\s+|$))/;

function isPrefixOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && stripSlackIncidentAllowedPrefixes(trimmed) === "";
}

function isAngleBracketMetadataLine(line: string): boolean {
  const trimmed = stripSlackIncidentAllowedPrefixes(line.trim());
  if (!trimmed) {
    return false;
  }
  return ANGLE_BRACKET_METADATA_LINE_RE.test(trimmed);
}

function normalizeLineForProgressCheck(line: string): {
  text: string;
  hasSummaryLabel: boolean;
  hasSummaryBlock: boolean;
} {
  let trimmed = stripSlackIncidentAllowedPrefixes(line.trim());
  if (!trimmed) {
    return { text: "", hasSummaryLabel: false, hasSummaryBlock: false };
  }
  const hasSummaryLabel = SUMMARY_LABEL_RE.test(trimmed);
  if (hasSummaryLabel) {
    trimmed = trimmed.replace(SUMMARY_LABEL_RE, "").trimStart();
  }
  const hasSummaryBlock = SUMMARY_BLOCK_RE.test(trimmed);
  if (hasSummaryBlock) {
    trimmed = trimmed.replace(SUMMARY_BLOCK_RE, "").trimStart();
  }
  return { text: trimmed, hasSummaryLabel, hasSummaryBlock };
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function looksLikeProgressOnlyLine(line: string): boolean {
  const normalized = normalizeLineForProgressCheck(line);
  const trimmed = normalized.text;
  if (!trimmed) {
    return normalized.hasSummaryLabel || normalized.hasSummaryBlock;
  }
  if (PROGRESS_ONLY_EXACT_LINE_RES.some((re) => re.test(trimmed))) {
    return true;
  }
  if (GOOD_DASHED_PROGRESS_PREFIX_RE.test(trimmed)) {
    return true;
  }
  if (SUBSTANTIVE_PROGRESS_SUFFIX_RE.test(trimmed)) {
    return false;
  }
  const matchedProceduralPrefix =
    PROCEDURAL_PROGRESS_PREFIX_RES.some((re) => re.test(trimmed)) ||
    DASHED_PROGRESS_PREFIX_RES.some((re) => re.test(trimmed)) ||
    FIRST_PERSON_PROGRESS_PREFIX_RE.test(trimmed);
  if (!matchedProceduralPrefix) {
    return false;
  }
  if (normalized.hasSummaryLabel) {
    return countWords(trimmed) <= MAX_LABELED_PROGRESS_WORDS;
  }
  return true;
}

export function sanitizeIncidentMessage(text: string): string {
  const lines = text.split("\n");
  const preservedPrefixes: string[] = [];
  let contentStart = 0;

  while (contentStart < lines.length) {
    const line = lines[contentStart] ?? "";
    if (!line.trim()) {
      contentStart += 1;
      continue;
    }
    if (!isPrefixOnlyLine(line)) {
      break;
    }
    preservedPrefixes.push(line);
    contentStart += 1;
  }

  let trimmedLeadingNoise = false;
  while (contentStart < lines.length) {
    const line = lines[contentStart] ?? "";
    if (!line.trim()) {
      contentStart += 1;
      continue;
    }
    if (isAngleBracketMetadataLine(line)) {
      contentStart += 1;
      trimmedLeadingNoise = true;
      continue;
    }
    if (!looksLikeProgressOnlyLine(line)) {
      break;
    }
    contentStart += 1;
    trimmedLeadingNoise = true;
  }

  if (!trimmedLeadingNoise) {
    return text.trim();
  }

  const remainder = lines.slice(contentStart).join("\n").trim();
  if (!remainder) {
    // Edge case: every non-prefix line was progress chatter, so preserve any
    // routing prefixes and drop the chatter instead of reintroducing it.
    return preservedPrefixes.join("\n").trim();
  }

  return [...preservedPrefixes, remainder].join("\n").trim();
}

function isProgressOnlyChatterFromSanitized(trimmed: string): boolean {
  if (!trimmed.trim()) {
    return true;
  }

  const lines = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isPrefixOnlyLine(line));
  if (lines.length === 0) {
    return true;
  }
  return lines.every((line) => looksLikeProgressOnlyLine(line));
}

/**
 * Progress-only incident messages are pure play-by-play with no substantive
 * summary content after lightweight trimming.
 */
export function isProgressOnlyChatter(text: string): boolean {
  const trimmed = sanitizeIncidentMessage(text);
  return isProgressOnlyChatterFromSanitized(trimmed);
}

export const isProgressOnlyMessage = isProgressOnlyChatter;

/**
 * Incident-channel replies may be free-form summaries, but must not be pure
 * progress chatter.
 */
export function shouldBlockIncidentMessage(text: string): boolean {
  return isProgressOnlyChatter(text);
}

export function createSreIncidentFormatPlugin(): OpenClawPluginDefinition {
  return {
    id: SRE_INCIDENT_FORMAT_PLUGIN_ID,
    name: "SRE Incident Summary Gate",
    version: "2.5.1",
    description:
      "Last-resort incident reply scrubber: trims leading progress chatter and blocks pure play-by-play updates. Free-form final summaries are allowed.",
    register(api) {
      api.on(
        "message_sending",
        (event, ctx) => {
          const content = event.content;
          if (!content?.trim()) {
            return;
          }

          // Only enforce for Slack messages.
          const surfaceId = ctx.channelId;
          if (surfaceId !== "slack") {
            return;
          }

          // Resolve the Slack conversation ID.
          const metadata = event.metadata ?? {};
          const slackConversationId =
            (metadata.channelId as string | undefined) ?? (event.to as string | undefined);

          // Only enforce in incident channels. All other channels (DMs, group
          // channels, #router-investigator, etc.) are unfiltered.
          if (!isSreIncidentChannelId(slackConversationId)) {
            return;
          }

          const sanitized = sanitizeIncidentMessage(content);
          if (sanitized !== content.trim()) {
            logVerbose(
              `sre-incident-format: trimmed leading progress chatter for ${slackConversationId}`,
            );
          }

          if (isProgressOnlyChatterFromSanitized(sanitized)) {
            logVerbose(
              `sre-incident-format: blocked progress-only reply for ${slackConversationId}`,
            );
            return { cancel: true };
          }

          if (sanitized !== content.trim()) {
            return { content: sanitized };
          }

          return;
        },
        { priority: -1000 },
      );
    },
  };
}
