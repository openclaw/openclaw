import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentIdentity } from "../agents/identity.js";
import type { SlackPersona } from "./send.js";

/**
 * Wraps an emoji string in colons for Slack icon_emoji format.
 * Handles:
 * - Already-colonized: ":robot_face:" → ":robot_face:"
 * - Slack shortcode: "robot_face" → ":robot_face:"
 * - Unicode emoji: "🗺️" → "🗺️" (returned as icon_emoji which Slack handles)
 */
function normalizeSlackEmoji(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  // Already wrapped in colons — pass through.
  if (trimmed.startsWith(":") && trimmed.endsWith(":") && trimmed.length > 2) {
    return trimmed;
  }
  // Looks like a Slack shortcode (alphanumeric + underscores/hyphens).
  if (/^[a-z0-9_+-]+$/i.test(trimmed)) {
    return `:${trimmed}:`;
  }
  // Unicode emoji or other — return as-is (Slack icon_emoji accepts these).
  return trimmed;
}

/**
 * Resolve the Slack display persona for an agent.
 * Returns undefined when no identity is configured or the agent id is missing.
 */
export function resolveSlackPersona(
  cfg: OpenClawConfig,
  agentId: string | null | undefined,
): SlackPersona | undefined {
  if (!agentId) {
    return undefined;
  }
  const identity = resolveAgentIdentity(cfg, agentId);
  if (!identity) {
    return undefined;
  }
  const persona: SlackPersona = {};
  const name = identity.name?.trim();
  if (name) {
    persona.username = name;
  }
  // Prefer avatar URL for icon (higher fidelity than emoji).
  const avatar = identity.avatar?.trim();
  if (avatar && (avatar.startsWith("http://") || avatar.startsWith("https://"))) {
    persona.iconUrl = avatar;
  } else {
    const emoji = identity.emoji?.trim();
    if (emoji) {
      persona.iconEmoji = normalizeSlackEmoji(emoji);
    }
  }
  // Only return a persona if at least one field is set.
  if (!persona.username && !persona.iconEmoji && !persona.iconUrl) {
    return undefined;
  }
  return persona;
}
