import { isSreIncidentChannelId } from "../../../slack/monitor/incident-channels.js";
import {
  SLACK_INCIDENT_HEADER_RE,
  startsWithSlackIncidentHeaderAfterAllowedPrefixes,
  stripSlackIncidentAllowedPrefixes,
} from "../../../slack/monitor/incident-format.js";
import type { OpenClawPluginDefinition } from "../../types.js";

export const SRE_INCIDENT_FORMAT_PLUGIN_ID = "sre-incident-format";
const CUSTOMER_IMPACT_LABEL_RE = /^(?:\*Customer impact:\*|_Customer impact:_)/i;
const STATUS_LABEL_RE = /^(?:\*Status:\*|_Status:_)/i;
const EVIDENCE_LABEL_RE = /^(?:\*Evidence:\*|_Evidence:_)/i;

export function hasRequiredIncidentSections(text: string): boolean {
  let hasIncident = false;
  let hasCustomerImpact = false;
  let hasStatus = false;
  let hasEvidence = false;

  for (const rawLine of text.split("\n")) {
    const line = stripSlackIncidentAllowedPrefixes(rawLine.trim());
    if (!line) {
      continue;
    }
    if (SLACK_INCIDENT_HEADER_RE.test(line)) {
      hasIncident = true;
    }
    if (CUSTOMER_IMPACT_LABEL_RE.test(line)) {
      hasCustomerImpact = true;
    }
    if (STATUS_LABEL_RE.test(line)) {
      hasStatus = true;
    }
    if (EVIDENCE_LABEL_RE.test(line)) {
      hasEvidence = true;
    }
  }

  return hasIncident && hasCustomerImpact && hasStatus && hasEvidence;
}

/**
 * Progress-only incident messages never reach the incident header first.
 */
export function isProgressOnlyMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return !startsWithSlackIncidentHeaderAfterAllowedPrefixes(trimmed);
}

/**
 * Check if a message should be blocked in an incident channel.
 *
 * Incident-channel replies must open with the Incident header, optionally
 * after routing tags or bare Slack mention tokens. Any narration before the
 * header is treated as intermediate thinking and blocked. Replies that do not
 * include the minimum Incident, Customer impact, Status, and Evidence sections
 * are also blocked.
 */
export function shouldBlockIncidentMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return isProgressOnlyMessage(trimmed) || !hasRequiredIncidentSections(trimmed);
}

export function createSreIncidentFormatPlugin(): OpenClawPluginDefinition {
  return {
    id: SRE_INCIDENT_FORMAT_PLUGIN_ID,
    name: "SRE Incident Format Enforcer",
    version: "2.2.0",
    description:
      "In incident channels, blocks messages that narrate before the incident header or omit required incident sections. Other channels are unfiltered.",
    register(api) {
      api.on("message_sending", (event, ctx) => {
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

        // Block any message that narrates before the incident header.
        if (shouldBlockIncidentMessage(content)) {
          return { cancel: true };
        }

        return;
      });
    },
  };
}
