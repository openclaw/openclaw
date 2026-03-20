import type { OpenClawPluginDefinition } from "../../types.js";

export const SRE_INCIDENT_FORMAT_PLUGIN_ID = "sre-incident-format";

// Section labels that must use *bold* not _italic_ in incident replies.
const INCIDENT_LABELS = [
  "Incident",
  "Customer impact",
  "Affected services",
  "Status",
  "Evidence",
  "Likely cause",
  "Mitigation",
  "Validate",
  "Next",
  "Also watching",
  "Auto-fix PR",
  "Linear",
  "Suggested PR",
  "Fix PR",
  "Context",
  "What the PR does",
] as const;

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

// Build regex that matches _Label:_ at start of line and replaces with *Label:*
function buildLabelFixRegex(): RegExp {
  const escaped = INCIDENT_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Match _Label:_ at start of line only — incident labels always appear at line start.
  return new RegExp(`(?:^|(?<=\\n))_(${escaped.join("|")}):_`, "gm");
}

const LABEL_FIX_RE = buildLabelFixRegex();

// Quick check: does the text contain any incident section label in bold format?
// Used to distinguish substantive incident replies from progress noise.
const INCIDENT_LABEL_BOLD_RE = /\*(?:Incident|Evidence|Mitigation|Likely cause|Status):\*/;

/**
 * Replace italic incident section labels with bold equivalents.
 * _Incident:_ → *Incident:*
 */
export function enforceIncidentLabelFormat(text: string): string {
  return text.replace(LABEL_FIX_RE, "*$1:*");
}

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
    description:
      "Enforces bold section labels and blocks progress-only messages in SRE incident threads.",
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

        // Fix italic labels → bold labels
        const fixed = enforceIncidentLabelFormat(content);
        if (fixed !== content) {
          return { content: fixed };
        }

        return;
      });
    },
  };
}
