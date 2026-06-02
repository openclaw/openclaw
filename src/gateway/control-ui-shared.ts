import {
  isAvatarHttpUrl,
  isAvatarImageDataUrl,
  looksLikeAvatarPath,
} from "../shared/avatar-policy.js";

const CONTROL_UI_AVATAR_PREFIX = "/avatar";

/** Normalizes optional Control UI mount paths to an empty string or leading-slash path. */
export function normalizeControlUiBasePath(basePath?: string): string {
  if (!basePath) {
    return "";
  }
  let normalized = basePath.trim();
  if (!normalized) {
    return "";
  }
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  if (normalized === "/") {
    return "";
  }
  if (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/** Builds the Gateway-served assistant avatar route for an already-normalized base path. */
export function buildControlUiAvatarUrl(basePath: string, agentId: string): string {
  return basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/${agentId}`
    : `${CONTROL_UI_AVATAR_PREFIX}/${agentId}`;
}

/** Resolves config avatar values to browser-usable URLs without rewriting absolute/data URLs. */
export function resolveAssistantAvatarUrl(params: {
  /** Configured avatar value: absolute URL, data URL, local path, or legacy avatar path. */
  avatar?: string | null;
  /** Agent id used when a configured path should route through the Gateway avatar endpoint. */
  agentId?: string | null;
  /** Optional Control UI mount path that prefixes Gateway-owned avatar routes. */
  basePath?: string;
}): string | undefined {
  const avatar = params.avatar?.trim();
  if (!avatar) {
    return undefined;
  }
  if (isAvatarHttpUrl(avatar) || isAvatarImageDataUrl(avatar)) {
    return avatar;
  }

  const basePath = normalizeControlUiBasePath(params.basePath);
  const baseAvatarPrefix = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (basePath && avatar.startsWith(`${CONTROL_UI_AVATAR_PREFIX}/`)) {
    return `${basePath}${avatar}`;
  }
  if (avatar.startsWith(baseAvatarPrefix)) {
    return avatar;
  }

  if (!params.agentId) {
    return avatar;
  }
  if (looksLikeAvatarPath(avatar)) {
    return buildControlUiAvatarUrl(basePath, params.agentId);
  }
  return avatar;
}

export { CONTROL_UI_AVATAR_PREFIX };
