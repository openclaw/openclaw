import { containsSlackIncidentLabel } from "../../../slack/format.js";
import type { OpenClawPluginDefinition } from "../../types.js";

export const SRE_INCIDENT_FORMAT_PLUGIN_ID = "sre-incident-format";

// Incident-only channels where the strict content gate applies.
// Messages in these channels MUST contain incident section labels or they are blocked.
// Other channels (DMs, #router-investigator, etc.) are not filtered.
const INCIDENT_CHANNEL_IDS = new Set([
  "C07G53ZCV5K", // #bug-report
  "C0A3T6VVCPQ", // #platform-monitoring
  "C09EQ94AN1L", // #staging-infra-monitoring
  "C08BZRS6W12", // #public-api-monitoring
]);

/**
 * Check if a message should be blocked in an incident channel.
 *
 * Only messages containing at least one incident section label
 * (*Incident:*, *Evidence:*, _Status:_, etc.) are allowed through.
 * Everything else is intermediate thinking.
 */
export function isProgressOnlyMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  return !containsSlackIncidentLabel(trimmed);
}

export function createSreIncidentFormatPlugin(): OpenClawPluginDefinition {
  return {
    id: SRE_INCIDENT_FORMAT_PLUGIN_ID,
    name: "SRE Incident Format Enforcer",
    version: "2.1.0",
    description:
      "In incident channels, blocks messages without incident section labels. Other channels are unfiltered.",
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
        if (!slackConversationId || !INCIDENT_CHANNEL_IDS.has(slackConversationId)) {
          return;
        }

        // Block any message that doesn't contain incident section labels.
        if (isProgressOnlyMessage(content)) {
          return { cancel: true };
        }

        return;
      });
    },
  };
}
