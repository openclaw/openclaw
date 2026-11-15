import { resolveMutableAgentEntry } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareGatewayAvatarDataUrl } from "./assistant-avatar-cache.js";

/** Selected avatars are persisted in config; remote images never trigger push-time network I/O. */
export async function prepareWebPushAgentIcon(cfg: OpenClawConfig, agentId: string | undefined) {
  if (!agentId) {
    return undefined;
  }
  const avatar = resolveMutableAgentEntry(cfg, agentId)?.identity?.avatar;
  const source = avatar ? prepareGatewayAvatarDataUrl(cfg, agentId, avatar) : undefined;
  if (!source) {
    return undefined;
  }
  const { readGatewayAvatarNotificationIcon } =
    await import("./assistant-avatar-thumbnail.runtime.js");
  const icon = await readGatewayAvatarNotificationIcon(source);
  return icon ? { agentId, avatar, icon } : undefined;
}

/** Recheck the selected identity after image preparation and recipient-authority reads. */
export function currentWebPushAgentIcon(
  cfg: OpenClawConfig,
  prepared: Awaited<ReturnType<typeof prepareWebPushAgentIcon>>,
): string | undefined {
  return prepared &&
    resolveMutableAgentEntry(cfg, prepared.agentId)?.identity?.avatar === prepared.avatar
    ? prepared.icon
    : undefined;
}
