import type { ThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { isReservedSystemAgentId } from "../../../src/system-agent/agent-id.js";
import { fnv1aUtf16 } from "../lib/fnv1a.ts";

// One roll per agent and page load keeps every avatar surface in agreement.
const LOAD_SALT = Math.trunc(Math.random() * 0xffffffff);

export function resolveAvatarHat(
  agentId: string,
  branding: Pick<ThemeBranding, "mascot" | "avatarHat">,
): string | null {
  if (!branding.avatarHat || isReservedSystemAgentId(agentId)) {
    return null;
  }
  const seed = (fnv1aUtf16(agentId) ^ LOAD_SALT) >>> 0;
  return seed % 6 === 0 ? branding.avatarHat : null;
}
