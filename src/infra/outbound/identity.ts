import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import { resolveAgentIdentity } from "../../agents/identity.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundIdentity } from "./identity-types.js";

export type { OutboundIdentity } from "./identity-types.js";

/** Resolves an agent's configured identity into channel-safe outbound metadata. */
export function resolveAgentOutboundIdentity(
  cfg: OpenClawConfig,
  agentId: string,
): OutboundIdentity | undefined {
  const identity = resolveAgentIdentity(cfg, agentId);
  const avatar = resolveAgentAvatar(cfg, agentId);
  const name = normalizeOptionalString(identity?.name);
  const avatarUrl = normalizeOptionalString(avatar.kind === "remote" ? avatar.url : undefined);
  const emoji = normalizeOptionalString(identity?.emoji);
  const theme = normalizeOptionalString(identity?.theme);
  if (!name && !avatarUrl && !emoji && !theme) {
    return undefined;
  }
  return { name, avatarUrl, emoji, theme };
}
