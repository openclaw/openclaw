/**
 * Resolve capabilities from a plugin manifest declaration + optional user overrides.
 */

import {
  ALL_REGISTER_CAPABILITIES,
  ALL_RUNTIME_CAPABILITIES,
  CAPABILITY_WILDCARD,
  type PluginCapabilities,
  type PluginRegisterCapability,
  type PluginRuntimeCapability,
  type ResolvedCapabilities,
} from "./types.js";

const FULL_REGISTER_SET = new Set<string>([CAPABILITY_WILDCARD]);
const FULL_RUNTIME_SET = new Set<string>([CAPABILITY_WILDCARD]);

const VALID_REGISTER = new Set<string>(ALL_REGISTER_CAPABILITIES);
const VALID_RUNTIME = new Set<string>(ALL_RUNTIME_CAPABILITIES);

/**
 * Create a ResolvedCapabilities from a manifest declaration and optional overrides.
 *
 * Resolution rules:
 * 1. If no capabilities declared (undefined), grant full access (["*"]).
 * 2. If declared, filter to valid capability names.
 * 3. If user overrides exist, they replace (not merge) the manifest declaration.
 */
export function resolveCapabilities(
  manifest?: PluginCapabilities,
  overrides?: PluginCapabilities,
): ResolvedCapabilities {
  const source = overrides ?? manifest;

  // No capabilities declared → full access (backward compatible).
  if (!source) {
    return createUnrestrictedCapabilities();
  }

  const registerRaw = source.register;
  const runtimeRaw = source.runtime;

  // Build register set.
  const registerCaps = normalizeCapabilityList(registerRaw, VALID_REGISTER);
  const runtimeCaps = normalizeCapabilityList(runtimeRaw, VALID_RUNTIME);

  const registerIsWildcard = registerCaps.has(CAPABILITY_WILDCARD);
  const runtimeIsWildcard = runtimeCaps.has(CAPABILITY_WILDCARD);
  const isUnrestricted = registerIsWildcard && runtimeIsWildcard;

  return {
    hasRegister: registerIsWildcard
      ? () => true
      : (cap: PluginRegisterCapability) => registerCaps.has(cap),
    hasRuntime: runtimeIsWildcard
      ? () => true
      : (cap: PluginRuntimeCapability) => runtimeCaps.has(cap),
    isUnrestricted,
    registerCaps,
    runtimeCaps,
  };
}

/** Create a full-access capability set. */
export function createUnrestrictedCapabilities(): ResolvedCapabilities {
  return {
    hasRegister: () => true,
    hasRuntime: () => true,
    isUnrestricted: true,
    registerCaps: FULL_REGISTER_SET,
    runtimeCaps: FULL_RUNTIME_SET,
  };
}

function normalizeCapabilityList(
  raw: readonly string[] | undefined,
  valid: ReadonlySet<string>,
): Set<string> {
  if (!raw || !Array.isArray(raw)) {
    return new Set([CAPABILITY_WILDCARD]);
  }
  const result = new Set<string>();
  for (const entry of raw) {
    const cap = typeof entry === "string" ? entry.trim() : "";
    if (!cap) {
      continue;
    }
    if (cap === CAPABILITY_WILDCARD) {
      return new Set([CAPABILITY_WILDCARD]);
    }
    if (valid.has(cap)) {
      result.add(cap);
    }
  }
  // Empty list after filtering → still return empty (denied everything).
  return result;
}
