// Octopus Orchestrator — `octo:` config block loader (M0-11)
//
// `loadOctoConfig` extracts the `octo:` subtree from a parsed OpenClaw
// config object, deep-merges the user-provided values over
// DEFAULT_OCTO_CONFIG, validates the merged result against
// OctoConfigSchema, and returns the validated, typed config.
//
// Scope and DRY discipline:
//   - This loader does NOT read files from disk. File I/O, env
//     substitution, and OpenClaw-wide config merging are the existing
//     upstream OpenClaw config loader's concern; we take its parsed
//     output as input. This keeps the octo: validation subtree cleanly
//     scoped to src/octo/ with zero risk of diverging from the upstream
//     loader's semantics.
//   - This loader does NOT duplicate DEFAULT_OCTO_CONFIG or
//     OctoConfigSchema — both are imported from ./schema.ts. When
//     CONFIG.md changes, schema.ts is the single source of truth and
//     this loader continues to work unchanged.
//
// Feature-flag semantics:
//   - Per DECISIONS.md OCTO-DEC-027 and CONFIG.md §Feature flag, the
//     default config has `enabled: true` (flipped from false on M2 exit). The
//     loader emits exactly one INFO line on startup naming the
//     resolved `enabled` state so operators can see at a glance
//     whether octopus is active in this process.
//
// Error policy (matches CONFIG.md §Validation "No silent fallback to
// defaults on invalid keys"):
//   - Shape rejection (octo: present but not a plain object) throws.
//   - Schema validation failure throws with a message enumerating
//     the failing paths.
//   - Missing `octo:` key (undefined, null, or absent) resolves to a
//     shallow clone of DEFAULT_OCTO_CONFIG. Unrelated top-level keys
//     in the OpenClaw config (owned by other subsystems) are ignored.

import { Value } from "@sinclair/typebox/value";
import { DEFAULT_OCTO_CONFIG, OctoConfigSchema, type OctoConfig } from "./schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

// Deep-merge an arbitrarily nested user-provided value over a default
// value, stopping at array / primitive / null leaves (which are
// replaced whole-value by the user-provided side). Used for sub-trees
// of the octo: block where nested objects exist (e.g.
// scheduler.weights). Arrays and string maps (like classifier.hints)
// are leaves — whole-value replaced, never concatenated or key-merged.
function deepMergeValue(defaultValue: unknown, userValue: unknown): unknown {
  if (userValue === undefined) {
    return defaultValue;
  }
  if (!isPlainObject(defaultValue) || !isPlainObject(userValue)) {
    // Leaf: primitive, array, null, or object/non-object mismatch.
    // The user value wins verbatim. Schema validation will catch
    // any type mismatches downstream.
    return userValue;
  }
  const out: PlainObject = { ...defaultValue };
  for (const key of Object.keys(userValue)) {
    out[key] = deepMergeValue(defaultValue[key], userValue[key]);
  }
  return out;
}

// Merge rules specific to the top-level octo: block.
//
// Most top-level fields delegate to deepMergeValue, which handles the
// "user override wins at the leaf, object fields merge recursively"
// pattern (covering e.g. scheduler.weights as a two-level merge).
//
// Two fields have bespoke semantics:
//   - `classifier.hints` — a string→string map. We treat it as a
//     leaf (whole-value replace) to match the array-replacement rule.
//     This falls out naturally from deepMergeValue because the user's
//     hints object becomes the merged result when defaults.hints is
//     empty; but if a future default populates hints, we want the
//     user's map to REPLACE rather than merge. Handled via an
//     explicit pass-through below.
//   - `habitats` — a string→habitat map keyed by nodeId. We merge at
//     the map level (so multiple nodes' overrides coexist) but each
//     habitat value is taken from the user verbatim with NO deeper
//     merge (habitats are self-contained per-node overrides).
function mergeOctoBlock(user: PlainObject): OctoConfig {
  const merged: PlainObject = {};
  const defaults = DEFAULT_OCTO_CONFIG as unknown as PlainObject;

  for (const key of Object.keys(defaults)) {
    if (!(key in user)) {
      merged[key] = defaults[key];
      continue;
    }
    const userVal = user[key];

    if (key === "habitats") {
      // Map-level merge, per-habitat whole-value replace.
      if (userVal === undefined) {
        merged[key] = defaults[key];
        continue;
      }
      if (!isPlainObject(userVal)) {
        // Let schema validation reject this cleanly.
        merged[key] = userVal;
        continue;
      }
      const defaultHabitats = (defaults[key] as PlainObject) ?? {};
      merged[key] = { ...defaultHabitats, ...userVal };
      continue;
    }

    if (key === "classifier" && isPlainObject(userVal)) {
      // classifier.hints is a leaf (whole-map replace). Merge the
      // other classifier fields via deepMergeValue but pass hints
      // through verbatim when the user provides it.
      const defaultClassifier = defaults[key] as PlainObject;
      const mergedClassifier = deepMergeValue(defaultClassifier, userVal) as PlainObject;
      if ("hints" in userVal) {
        mergedClassifier.hints = userVal.hints;
      }
      merged[key] = mergedClassifier;
      continue;
    }

    merged[key] = deepMergeValue(defaults[key], userVal);
  }

  // Unknown top-level keys in the user block are copied through so
  // the strict-mode schema validator rejects them with a clear path.
  for (const key of Object.keys(user)) {
    if (!(key in defaults)) {
      merged[key] = user[key];
    }
  }

  return merged as unknown as OctoConfig;
}

// Format TypeBox validation errors into a single human-readable
// message listing each failing path and reason.
function formatValidationErrors(config: unknown): string {
  const errors = [...Value.Errors(OctoConfigSchema, config)];
  const lines = errors.map((err) => {
    const path = err.path && err.path.length > 0 ? err.path : "/";
    return `  at ${path}: ${err.message}`;
  });
  return `Octopus config: validation failed\n${lines.join("\n")}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export interface LoadOctoConfigOptions {
  /**
   * Single-line info logger used to announce the resolved `enabled`
   * state at startup. Defaults to `console.info`. Tests inject a spy.
   */
  readonly logger?: (msg: string) => void;
}

/**
 * Extract, merge, and validate the `octo:` block from a parsed
 * OpenClaw config object. Returns a fully-populated, schema-validated
 * OctoConfig ready for runtime consumption.
 *
 * @param rawOpenclawConfig - the parsed openclaw.json root object as
 *   produced by the upstream OpenClaw config loader
 * @param opts - optional logger injection for startup line capture
 * @throws if `rawOpenclawConfig` is not a plain object, if
 *   `rawOpenclawConfig.octo` exists but is not a plain object, or if
 *   the merged config fails schema validation
 */
export function loadOctoConfig(
  rawOpenclawConfig: Readonly<Record<string, unknown>>,
  opts?: LoadOctoConfigOptions,
): OctoConfig {
  const logger = opts?.logger ?? ((msg: string) => console.info(msg));

  if (!isPlainObject(rawOpenclawConfig)) {
    throw new Error("Octopus config: rawOpenclawConfig must be an object");
  }

  const rawOcto = rawOpenclawConfig.octo;

  let resolved: OctoConfig;

  if (rawOcto === undefined || rawOcto === null) {
    // Missing block → shallow clone of defaults so the caller can't
    // mutate the frozen module-level default by accident.
    resolved = { ...DEFAULT_OCTO_CONFIG };
  } else if (!isPlainObject(rawOcto)) {
    throw new Error(
      `Octopus config: expected \`octo\` block to be an object, got ${describeType(rawOcto)}`,
    );
  } else {
    const merged = mergeOctoBlock(rawOcto);
    if (!Value.Check(OctoConfigSchema, merged)) {
      throw new Error(formatValidationErrors(merged));
    }
    resolved = merged;
  }

  logger(`octopus orchestrator: enabled=${resolved.enabled}`);
  return resolved;
}
