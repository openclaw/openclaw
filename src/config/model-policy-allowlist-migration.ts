// Shared legacy model allowlist detection for runtime, doctor, and config writes.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../utils.js";
import {
  isModelPolicyCompatSelector,
  isValidExactModelPolicyRef,
  parseModelPolicyWildcardRef,
} from "./model-policy-ref.js";

export const MODEL_POLICY_ALLOWLIST_MIGRATION_MARKER = "modelPolicyAllowlist";

export function hasModelPolicyAllowlistMigrationMarker(value: unknown): boolean {
  if (
    isRecord(value) &&
    isRecord(value.meta) &&
    isRecord(value.meta.migrations) &&
    value.meta.migrations[MODEL_POLICY_ALLOWLIST_MIGRATION_MARKER] === true
  ) {
    return true;
  }
  return false;
}

/** Any policy object opts into the explicit model-policy semantics. */
export function isExplicitModelPolicy(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

/** A per-agent policy replaces inherited defaults only when it owns `allow`. */
export function hasExplicitModelPolicyAllow(value: unknown): boolean {
  return isExplicitModelPolicy(value) && Object.hasOwn(value, "allow");
}

export function computeModelPolicyAllowlist(params: {
  root: unknown;
  defaults: unknown;
}): string[] | null {
  // Unmarked persisted configs are indistinguishable from shipped legacy configs.
  // Preserve their restrictions until doctor or a config write stamps the marker.
  if (hasModelPolicyAllowlistMigrationMarker(params.root)) {
    return null;
  }
  return collectLegacyDefaultModelAllowRefs(params.defaults);
}

function collectLegacyDefaultModelAllowRefs(defaults: unknown): string[] | null {
  if (!isRecord(defaults)) {
    return null;
  }
  // An explicit modelPolicy object (even `{}`, which means allow-any) opts into the
  // new semantics, so a sibling models map stays metadata-only and is never read as
  // a legacy allowlist.
  if (isExplicitModelPolicy(defaults.modelPolicy)) {
    return null;
  }
  if (!isRecord(defaults.models)) {
    return null;
  }
  // Aliases configured on the legacy map stay valid policy refs, so keys matching
  // a declared alias are preserved alongside exact refs, wildcards, and compat
  // selectors. Bare slashless provider keys without an alias are runtime-dead and
  // rejected by the config writer, so they are dropped instead of copied verbatim.
  const aliases = new Set<string>();
  for (const entry of Object.values(defaults.models)) {
    if (isRecord(entry)) {
      const alias = normalizeLowercaseStringOrEmpty(entry.alias);
      if (alias) {
        aliases.add(alias);
      }
    }
  }
  const refs = Object.keys(defaults.models).filter((key) => {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      return false;
    }
    return (
      aliases.has(normalizeLowercaseStringOrEmpty(trimmed)) ||
      isModelPolicyCompatSelector(trimmed) ||
      isValidExactModelPolicyRef(trimmed) ||
      parseModelPolicyWildcardRef(trimmed) !== null
    );
  });
  // Return an empty array (not null) when every legacy key is invalid so the
  // runtime treats the map as a known-but-empty restriction (fail-closed).
  // The Doctor migration handles the empty case separately to avoid stamping
  // the migration marker and retiring the legacy restriction.
  return refs.length > 0 ? refs : [];
}
