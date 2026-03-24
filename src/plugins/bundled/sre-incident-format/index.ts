import { logVerbose } from "../../../globals.js";
import { isSreIncidentChannelId } from "../../../slack/monitor/incident-channels.js";
import { stripSlackIncidentAllowedPrefixes } from "../../../slack/monitor/incident-format.js";
import type { OpenClawPluginDefinition } from "../../types.js";

export const SRE_INCIDENT_FORMAT_PLUGIN_ID = "sre-incident-format";
const PROGRESS_ONLY_LINE_RES = [
  /^(?:on it|found it|checking(?:\.\.\.)?|let me verify)\b/i,
  /^(?:now\s+)?let me\b/i,
  /^i need to\b/i,
  /^(?:ok|okay|wait)\b/i,
  /^good\s+[--]/i,
  /^the script\b/i,
  /^there are stale changes\b/i,
  /^the commit was created\b/i,
  /^pr is created\b/i,
  /^now i see some issues\b/i,
  /^honest answer\b/i,
  /^i(?:'m| am)\s+(?:going to|now going to|checking|looking into|pulling)\b/i,
  /^this should work\b/i,
  /^the code looks correct here\b/i,
];
const SUMMARY_LABEL_RE = /^(?:\*[^*\n]+:\*|_[^_\n]+:_)/;
const SUMMARY_BLOCK_RE = /^(?:#{1,6}\s+|[-*]\s+|\d+\.\s+)/;

function isPrefixOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && stripSlackIncidentAllowedPrefixes(trimmed) === "";
}

function isSummaryAnchorLine(line: string): boolean {
  const trimmed = stripSlackIncidentAllowedPrefixes(line.trim());
  if (!trimmed) {
    return false;
  }
  return SUMMARY_LABEL_RE.test(trimmed) || SUMMARY_BLOCK_RE.test(trimmed);
}

function looksLikeProgressOnlyLine(line: string): boolean {
  const trimmed = stripSlackIncidentAllowedPrefixes(line.trim());
  if (!trimmed) {
    return false;
  }
  return PROGRESS_ONLY_LINE_RES.some((re) => re.test(trimmed));
}

export function sanitizeIncidentMessage(text: string): string {
  const lines = text.split("\n");
  const anchorIndex = lines.findIndex((line) => isSummaryAnchorLine(line));
  if (anchorIndex <= 0) {
    return text.trim();
  }

  const leadingContent = lines
    .slice(0, anchorIndex)
    .filter((line) => line.trim())
    .filter((line) => !isPrefixOnlyLine(line));
  if (leadingContent.length === 0) {
    return text.trim();
  }

  const preservedPrefixes = lines.slice(0, anchorIndex).filter((line) => isPrefixOnlyLine(line));
  return [...preservedPrefixes, ...lines.slice(anchorIndex)].join("\n").trim();
}

/**
 * Progress-only incident messages are pure play-by-play with no substantive
 * summary content after lightweight trimming.
 */
export function isProgressOnlyMessage(text: string): boolean {
  const trimmed = sanitizeIncidentMessage(text);
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
  if (lines.some((line) => isSummaryAnchorLine(line))) {
    return false;
  }
  return lines.every((line) => looksLikeProgressOnlyLine(line));
}

/**
 * Incident-channel replies may be free-form summaries, but must not be pure
 * progress chatter.
 */
export function shouldBlockIncidentMessage(text: string): boolean {
  return isProgressOnlyMessage(text);
}

export function createSreIncidentFormatPlugin(): OpenClawPluginDefinition {
  return {
    id: SRE_INCIDENT_FORMAT_PLUGIN_ID,
    name: "SRE Incident Summary Gate",
    version: "2.3.0",
    description:
      "In incident channels, trims leading progress chatter and blocks pure play-by-play updates. Free-form final summaries are allowed.",
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

          if (shouldBlockIncidentMessage(sanitized)) {
            logVerbose(
              `sre-incident-format: blocked progress-only reply for ${slackConversationId}`,
            );
            return { cancel: true };
          }

          if (sanitized !== content.trim()) {
            return { content: sanitized, cancel: false };
          }

          return;
        },
        { priority: -1000 },
      );
    },
  };
}
