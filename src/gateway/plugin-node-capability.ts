import { randomBytes } from "node:crypto";
import {
  asDateTimestampMs,
  asPositiveSafeInteger,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { safeEqualSecret } from "../security/secret-equal.js";

export const PLUGIN_NODE_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
const PLUGIN_NODE_CAPABILITY_QUERY_PARAM = "oc_cap";
export const DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS = 10 * 60_000;

export type PluginNodeCapabilitySurface = {
  /** Plugin-owned surface name that needs a scoped node capability token. */
  surface: string;
  /** Optional token lifetime override for this surface. */
  ttlMs?: number;
  /** Optional extra storage scope for multiple capabilities on one surface. */
  scopeKey?: string;
};

export type PluginNodeCapabilityClient = {
  /** Surface URL map exposed by a node/plugin client. */
  pluginSurfaceUrls?: Record<string, string>;
  /** Capability surface definitions advertised by the client. */
  pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
  /** Minted capability tokens by normalized storage key. */
  pluginNodeCapabilities?: Record<string, { capability: string; expiresAtMs: number }>;
};

/** Index capability surfaces by normalized surface, keeping the shortest TTL. */
export function indexPluginNodeCapabilitySurfaces(
  surfaces: readonly PluginNodeCapabilitySurface[],
): Record<string, PluginNodeCapabilitySurface> {
  const indexed: Record<string, PluginNodeCapabilitySurface> = {};
  for (const entry of surfaces) {
    const surface = normalizeSurface(entry.surface);
    if (!surface) {
      continue;
    }
    const existing = indexed[surface];
    const next = { ...entry, surface };
    if (
      !existing ||
      resolvePluginNodeCapabilityTtlMs(next) < resolvePluginNodeCapabilityTtlMs(existing)
    ) {
      indexed[surface] = next;
    }
  }
  return indexed;
}

export type NormalizedPluginNodeCapabilityUrl = {
  /** Canonical path after stripping any scoped capability prefix. */
  pathname: string;
  /** Capability token found in scoped path or query string. */
  capability?: string;
  /** Rewritten path/search suitable for downstream HTTP handling. */
  rewrittenUrl?: string;
  /** Whether the URL used the scoped capability path prefix. */
  scopedPath: boolean;
  /** Whether the scoped capability path was malformed. */
  malformedScopedPath: boolean;
};

function normalizeCapability(raw: string | null | undefined) {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSurface(raw: string | undefined) {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function resolvePluginNodeCapabilityStorageKey(surface: PluginNodeCapabilitySurface) {
  const normalizedSurface = normalizeSurface(surface.surface);
  if (!normalizedSurface) {
    return undefined;
  }
  const scopeKey = surface.scopeKey?.trim();
  return scopeKey ? `${normalizedSurface}\0${scopeKey}` : normalizedSurface;
}

/** Resolve a capability surface TTL, falling back to the default. */
export function resolvePluginNodeCapabilityTtlMs(surface: PluginNodeCapabilitySurface) {
  return asPositiveSafeInteger(surface.ttlMs) ?? DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS;
}

/** Resolve the expiry timestamp for a capability surface. */
export function resolvePluginNodeCapabilityExpiresAtMs(
  surface: PluginNodeCapabilitySurface,
  nowMs: number = Date.now(),
): number | undefined {
  return resolveExpiresAtMsFromDurationMs(resolvePluginNodeCapabilityTtlMs(surface), { nowMs });
}

/** Mint a random plugin node capability bearer token. */
export function mintPluginNodeCapabilityToken(): string {
  return randomBytes(18).toString("base64url");
}

/** Append a scoped capability path segment to a plugin host base URL. */
export function buildPluginNodeCapabilityScopedHostUrl(
  baseUrl: string,
  capability: string,
): string | undefined {
  const normalizedCapability = normalizeCapability(capability);
  if (!normalizedCapability) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    const trimmedPath = url.pathname.replace(/\/+$/, "");
    const prefix = `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(normalizedCapability)}`;
    url.pathname = `${trimmedPath}${prefix}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Replace or append a capability token in an existing scoped plugin host URL. */
export function replacePluginNodeCapabilityInScopedHostUrl(
  scopedUrl: string,
  capability: string,
): string | undefined {
  const normalizedCapability = normalizeCapability(capability);
  if (!normalizedCapability) {
    return undefined;
  }
  try {
    const url = new URL(scopedUrl);
    const prefix = `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/`;
    const markerStart = url.pathname.indexOf(prefix);
    if (markerStart < 0) {
      return buildPluginNodeCapabilityScopedHostUrl(scopedUrl, normalizedCapability);
    }
    const capabilityStart = markerStart + prefix.length;
    const nextSlashIndex = url.pathname.indexOf("/", capabilityStart);
    const capabilityEnd = nextSlashIndex >= 0 ? nextSlashIndex : url.pathname.length;
    if (capabilityEnd <= capabilityStart) {
      return undefined;
    }
    url.pathname =
      url.pathname.slice(0, capabilityStart) +
      encodeURIComponent(normalizedCapability) +
      url.pathname.slice(capabilityEnd);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Parse scoped capability URLs and rewrite them to downstream plugin paths. */
export function normalizePluginNodeCapabilityScopedUrl(
  rawUrl: string,
): NormalizedPluginNodeCapabilityUrl {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://localhost");
  } catch {
    return {
      pathname: "/",
      scopedPath: false,
      malformedScopedPath: true,
    };
  }
  const prefix = `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/`;
  let scopedPath = false;
  let malformedScopedPath = false;
  let capabilityFromPath: string | undefined;
  let rewrittenUrl: string | undefined;

  if (url.pathname.startsWith(prefix)) {
    scopedPath = true;
    const remainder = url.pathname.slice(prefix.length);
    const slashIndex = remainder.indexOf("/");
    if (slashIndex <= 0) {
      malformedScopedPath = true;
    } else {
      const encodedCapability = remainder.slice(0, slashIndex);
      const canonicalPath = remainder.slice(slashIndex) || "/";
      let decoded: string | undefined;
      try {
        decoded = decodeURIComponent(encodedCapability);
      } catch {
        malformedScopedPath = true;
      }
      capabilityFromPath = normalizeCapability(decoded);
      if (!capabilityFromPath || !canonicalPath.startsWith("/")) {
        malformedScopedPath = true;
      } else {
        url.pathname = canonicalPath;
        if (!url.searchParams.has(PLUGIN_NODE_CAPABILITY_QUERY_PARAM)) {
          url.searchParams.set(PLUGIN_NODE_CAPABILITY_QUERY_PARAM, capabilityFromPath);
        }
        rewrittenUrl = `${url.pathname}${url.search}`;
      }
    }
  }

  const capability =
    capabilityFromPath ??
    normalizeCapability(url.searchParams.get(PLUGIN_NODE_CAPABILITY_QUERY_PARAM));
  return {
    pathname: url.pathname,
    capability,
    rewrittenUrl,
    scopedPath,
    malformedScopedPath,
  };
}

/** Store a minted capability token on a client under the surface storage key. */
export function setClientPluginNodeCapability(params: {
  client: PluginNodeCapabilityClient;
  surface: PluginNodeCapabilitySurface;
  capability: string;
  expiresAtMs: number;
}) {
  const surface = normalizeSurface(params.surface.surface);
  const storageKey = resolvePluginNodeCapabilityStorageKey(params.surface);
  const expiresAtMs = asDateTimestampMs(params.expiresAtMs);
  if (!surface || !storageKey || expiresAtMs === undefined) {
    return;
  }
  params.client.pluginNodeCapabilities ??= {};
  params.client.pluginNodeCapabilities[storageKey] = {
    capability: params.capability,
    expiresAtMs,
  };
}

/** Mint and install a fresh scoped URL/token for a client's plugin surface. */
export function refreshClientPluginNodeCapability(params: {
  client: PluginNodeCapabilityClient;
  surface: PluginNodeCapabilitySurface;
  nowMs?: number;
}):
  | {
      surface: string;
      capability: string;
      expiresAtMs: number;
      scopedUrl: string;
    }
  | undefined {
  const surface = normalizeSurface(params.surface.surface);
  if (!surface) {
    return undefined;
  }
  const existingUrl = params.client.pluginSurfaceUrls?.[surface];
  if (!existingUrl) {
    return undefined;
  }
  const capabilitySurface = params.client.pluginNodeCapabilitySurfaces?.[surface] ?? params.surface;
  const capability = mintPluginNodeCapabilityToken();
  const nowMs = params.nowMs ?? Date.now();
  const expiresAtMs = resolvePluginNodeCapabilityExpiresAtMs(capabilitySurface, nowMs);
  if (expiresAtMs === undefined) {
    return undefined;
  }
  const scopedUrl = replacePluginNodeCapabilityInScopedHostUrl(existingUrl, capability);
  if (!scopedUrl) {
    return undefined;
  }
  params.client.pluginSurfaceUrls ??= {};
  params.client.pluginSurfaceUrls[surface] = scopedUrl;
  setClientPluginNodeCapability({
    client: params.client,
    surface: capabilitySurface,
    capability,
    expiresAtMs,
  });
  return {
    surface,
    capability,
    expiresAtMs,
    scopedUrl,
  };
}

/** Verify a capability token across clients and extend its expiry on success. */
export function hasAuthorizedPluginNodeCapability(params: {
  clients: Iterable<PluginNodeCapabilityClient>;
  surface: PluginNodeCapabilitySurface;
  capability: string;
  nowMs?: number;
}) {
  const surface = normalizeSurface(params.surface.surface);
  const storageKey = resolvePluginNodeCapabilityStorageKey(params.surface);
  if (!surface || !storageKey) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  const nextExpiresAtMs = resolvePluginNodeCapabilityExpiresAtMs(params.surface, nowMs);
  if (nextExpiresAtMs === undefined) {
    return false;
  }
  for (const client of params.clients) {
    const entry = client.pluginNodeCapabilities?.[storageKey];
    if (!entry || !isFutureDateTimestampMs(entry.expiresAtMs, { nowMs })) {
      continue;
    }
    if (safeEqualSecret(entry.capability, params.capability)) {
      entry.expiresAtMs = nextExpiresAtMs;
      return true;
    }
  }
  return false;
}
