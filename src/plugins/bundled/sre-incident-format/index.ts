import type { OpenClawPluginDefinition } from "../../types.js";

export const SRE_INCIDENT_FORMAT_PLUGIN_ID = "sre-incident-format";

// Phrases that indicate a progress-only message (no substantive content).
const PROGRESS_PREFIXES = [
  "now let me",
  "let me ",
  "i need to",
  "i'm checking",
  "i'm looking",
  "i'm pulling",
  "i found the",
  "found it",
  "checking",
  "good —",
  "good -",
  "the script",
  "there are stale",
  "the commit was created",
  "pr is created",
  "now i see",
  "honest answer",
  "even though this is",
  "i'll follow the full protocol",
  "on it",
  "let me verify",
  "let me compose",
  "let me check",
] as const;

// Quick check: does the text contain any incident section label in bold format?
// Used to distinguish substantive incident replies from progress noise.
const INCIDENT_LABEL_BOLD_RE =
  /\*(?:Incident|Customer impact|Affected services|Status|Evidence|Likely cause|Mitigation|Validate|Next|Also watching|Auto-fix PR|Linear|Suggested PR|Fix PR|Context):\*/;

/**
 * Check if a message is progress-only noise (no substantive content).
 * Returns true if the message should be blocked.
 */
export function isProgressOnlyMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  // Long messages are never progress-only.
  if (trimmed.length > 200) {
    return false;
  }
  // Messages containing incident section labels are substantive, not progress.
  if (INCIDENT_LABEL_BOLD_RE.test(trimmed)) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  return PROGRESS_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function createSreIncidentFormatPlugin(): OpenClawPluginDefinition {
  return {
    id: SRE_INCIDENT_FORMAT_PLUGIN_ID,
    name: "SRE Incident Format Enforcer",
    version: "1.0.0",
    description: "Blocks progress-only messages in SRE incident threads.",
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

        // Use metadata to get the Slack conversation ID.
        const metadata = event.metadata ?? {};
        const slackConversationId =
          (metadata.channelId as string | undefined) ?? (event.to as string | undefined);

        // Skip direct messages (Slack DM IDs start with "D").
        if (slackConversationId?.startsWith("D")) {
          return;
        }

        // Block progress-only messages
        if (isProgressOnlyMessage(content)) {
          return { cancel: true };
        }

        // Label enforcement is handled post-normalization in src/slack/format.ts
        // and src/slack/send.ts, not in this hook (the hook runs before the
        // Markdown→mrkdwn converter which would undo the fix).

        return;
      });
    },
  };
}
