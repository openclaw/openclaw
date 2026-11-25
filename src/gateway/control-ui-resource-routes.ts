import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import {
  CONTROL_UI_USER_AVATAR_PATH_PREFIX,
  CONTROL_UI_USER_AVATAR_PATH_SUFFIX,
} from "./control-ui-user-avatar-route.js";

const CONTROL_UI_ASSISTANT_MEDIA_PREFIX = "/__openclaw__/assistant-media";

export function resolveAssistantMediaRoutePath(basePath?: string): string {
  const normalizedBasePath =
    basePath && basePath !== "/" ? (basePath.endsWith("/") ? basePath.slice(0, -1) : basePath) : "";
  return `${normalizedBasePath}${CONTROL_UI_ASSISTANT_MEDIA_PREFIX}`;
}

const CONTROL_UI_RESOURCE_PREFIXES = {
  agentAvatar: "/avatar",
  catalogIcon: "/__openclaw__/catalog-icon",
  channelAvatar: "/__openclaw__/channel-avatar",
  linkFavicon: "/__openclaw__/link-favicon",
  pluginIcon: "/__openclaw__/plugin-icon",
  providerIcon: "/__openclaw__/provider-icon",
  pluginActivityIcon: "/__openclaw__/plugin-activity-icon",
  pluginThemeArt: "/__openclaw__/plugin-theme-art",
  projectIcon: "/__openclaw__/project-icon",
  userAvatar: CONTROL_UI_USER_AVATAR_PATH_PREFIX.slice(0, -1),
  workspaceIcon: "/__openclaw__/workspace-icon",
} as const;

export type ControlUiResourceRoute = keyof typeof CONTROL_UI_RESOURCE_PREFIXES;
type ControlUiResourcePathMatch =
  | { matched: false }
  | { matched: true; value: string | null; segments?: string[] };

function resourceSuffix(route: ControlUiResourceRoute): string {
  return route === "userAvatar" ? CONTROL_UI_USER_AVATAR_PATH_SUFFIX : "";
}

/** Builds one canonical, encoded Control UI resource path. */
export function buildControlUiResourcePath(
  route: ControlUiResourceRoute,
  basePath: string | null | undefined,
  value: string,
  segments: readonly string[] = [],
): string {
  const prefix = CONTROL_UI_RESOURCE_PREFIXES[route];
  const encoded = [value, ...segments].map(encodeURIComponent).join("/");
  return `${normalizeControlUiBasePath(basePath)}${prefix}/${encoded}${resourceSuffix(route)}`;
}

/** Parses exact encoded resource components while retaining malformed-route ownership. */
export function parseControlUiResourcePath(
  route: ControlUiResourceRoute,
  pathname: string | null | undefined,
  basePath?: string | null,
): ControlUiResourcePathMatch {
  if (!pathname) {
    return { matched: false };
  }
  const prefix = `${normalizeControlUiBasePath(basePath)}${CONTROL_UI_RESOURCE_PREFIXES[route]}/`;
  if (!pathname.startsWith(prefix)) {
    return { matched: false };
  }
  const remainder = pathname.slice(prefix.length);
  const suffix = resourceSuffix(route);
  if (!remainder.endsWith(suffix)) {
    return { matched: true, value: null };
  }
  const encoded = suffix ? remainder.slice(0, -suffix.length) : remainder;
  const parts = encoded.split("/");
  if (parts.length !== (route === "pluginThemeArt" ? 4 : 1) || parts.some((part) => !part)) {
    return { matched: true, value: null };
  }
  try {
    const [value, ...segments] = parts.map(decodeURIComponent);
    return { matched: true, value: value || null, ...(segments.length ? { segments } : {}) };
  } catch {
    return { matched: true, value: null };
  }
}

export function parseControlUiUserAvatarPath(
  pathname: string,
  basePath: string,
): ControlUiResourcePathMatch {
  const canonical = parseControlUiResourcePath("userAvatar", pathname);
  return canonical.matched
    ? canonical
    : parseControlUiResourcePath("userAvatar", pathname, basePath);
}

/** Keeps the accepted path's escape spelling while removing its optional mount. */
export function canonicalizeControlUiUserAvatarPath(
  pathname: string,
  basePath: string,
): string | undefined {
  const parsed = parseControlUiUserAvatarPath(pathname, basePath);
  if (!parsed.matched || !parsed.value) {
    return undefined;
  }
  return pathname.startsWith(CONTROL_UI_USER_AVATAR_PATH_PREFIX)
    ? pathname
    : pathname.slice(normalizeControlUiBasePath(basePath).length);
}

/** Builds the authenticated conversation-avatar URL for a session. */
export function buildControlUiChannelAvatarUrl(
  basePath: string,
  sessionKey: string,
  revision: string,
): string {
  // The revision keys client-side blob/404 caches: a replaced or restored
  // backing image must change the URL or mounted rows stay stale forever.
  const path = buildControlUiResourcePath("channelAvatar", basePath, sessionKey);
  return `${path}?v=${encodeURIComponent(revision)}`;
}

/** Matches an exact root-relative same-origin resource URL without parser reinterpretation. */
export function matchControlUiResourceUrl(
  route: ControlUiResourceRoute,
  value: string,
  basePath?: string | null,
): { value: string; search: string; hash: string } | undefined {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return undefined;
  }
  const origin = "http://openclaw.invalid";
  const parsed = URL.parse(value, origin);
  if (parsed?.origin !== origin || `${parsed.pathname}${parsed.search}${parsed.hash}` !== value) {
    return undefined;
  }
  const resource = parseControlUiResourcePath(route, parsed.pathname, basePath);
  return resource.matched && resource.value
    ? { value: resource.value, search: parsed.search, hash: parsed.hash }
    : undefined;
}
