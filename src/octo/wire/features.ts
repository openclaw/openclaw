// Octopus Orchestrator — hello-ok feature advertisement (M0-07)
//
// TypeBox schema and builder for the `features.octo` descriptor that the
// Gateway handshake layer injects into `hello-ok.features`. This is how
// clients discover Octopus support, as defined by:
//   - docs/octopus-orchestrator/HLD.md §Feature advertisement via hello-ok.features.octo
//   - docs/octopus-orchestrator/INTEGRATION.md §Client feature detection
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-036 (PTY/tmux + cli_exec
//     primary for external coding tools; structured_acp opt-in only)
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-037 (cli_exec as a
//     fourth adapter type)
//
// Scope and ownership:
//
//   - The schema exported here is the INNER `octo` object — i.e. the value
//     under `features.octo`. It is NOT the full `{features: {octo: ...}}`
//     wrapper; that wrapper is constructed by the Gateway handshake layer,
//     which composes `features.octo` alongside `features.methods` and
//     `features.events`. This file's responsibility ends at the octo value.
//
//   - `structured_acp` is opt-in only per OCTO-DEC-036, but the advertiser
//     does NOT unilaterally demote it from the list. If the configuration
//     layer decides (based on operator opt-in) that ACP is available on a
//     given node, it passes `structured_acp` in the adapters list and the
//     builder faithfully advertises it. Opt-in gating is a config-level
//     decision, not an advertiser-level one.
//
//   - Likewise, per-node adapter filtering (e.g. `cli_exec` unavailable
//     because no `claude` binary is on PATH) is performed by the config
//     layer before it calls `buildFeaturesOcto`. The builder advertises
//     exactly the list it is handed.

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { NonEmptyString } from "./primitives.ts";
import { AdapterTypeSchema, type AdapterType } from "./schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Version constant
//
// The `version` field of the octo feature descriptor is a string (the HLD
// example shows "1"). We single-source it here so the builder and tests do
// not drift from the advertised value.
// ──────────────────────────────────────────────────────────────────────────

export const FEATURES_OCTO_VERSION = "1" as const;

// ──────────────────────────────────────────────────────────────────────────
// Capabilities block
//
// The M0 baseline capability promise: mission budgets enforced, worktree
// claims arbitrated, forward-progress watchdog active. All three are
// required booleans. New capability flags added in later milestones will
// extend this shape with additive required fields and bump the outer
// `version`.
// ──────────────────────────────────────────────────────────────────────────

export const FeaturesOctoCapabilitiesSchema = Type.Object(
  {
    missionBudgets: Type.Boolean(),
    worktreeClaims: Type.Boolean(),
    forwardProgressWatchdog: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type FeaturesOctoCapabilities = Static<typeof FeaturesOctoCapabilitiesSchema>;

export const DEFAULT_FEATURES_OCTO_CAPABILITIES: FeaturesOctoCapabilities = {
  missionBudgets: true,
  worktreeClaims: true,
  forwardProgressWatchdog: true,
};

// ──────────────────────────────────────────────────────────────────────────
// FeaturesOcto — the inner `octo` descriptor
//
// Matches the HLD §Feature advertisement example exactly. The adapters
// array has no minItems constraint because a disabled Octopus install
// returns an empty list (enabled: false) while still rendering a valid
// descriptor shape.
// ──────────────────────────────────────────────────────────────────────────

export const FeaturesOctoSchema = Type.Object(
  {
    version: NonEmptyString,
    enabled: Type.Boolean(),
    adapters: Type.Array(AdapterTypeSchema),
    capabilities: FeaturesOctoCapabilitiesSchema,
  },
  { additionalProperties: false },
);
export type FeaturesOcto = Static<typeof FeaturesOctoSchema>;

// ──────────────────────────────────────────────────────────────────────────
// Builder
//
// Callers pass in whether Octopus is enabled on this node, the filtered
// adapter list (after config-level availability checks), and an optional
// capabilities partial. The builder:
//
//   1. If disabled: returns the canonical disabled descriptor — empty
//      adapter list, default capabilities block, version "1". The
//      capability block is still present so clients see a well-formed
//      descriptor.
//
//   2. If enabled: deduplicates adapters preserving insertion order,
//      validates each adapter name at runtime against AdapterTypeSchema
//      (runtime callers may pass untyped config values — belt-and-
//      suspenders), and merges capability overrides over the defaults.
//
//   3. In both branches, the built descriptor is cross-checked against
//      FeaturesOctoSchema before return. This is the belt-and-suspenders
//      pattern established in M0-01: schema defines SHAPE, builder
//      enforces business rules, and a final Value.Check catches any drift
//      between the two.
// ──────────────────────────────────────────────────────────────────────────

export interface BuildFeaturesOctoInput {
  enabled: boolean;
  adapters: readonly AdapterType[];
  capabilities?: Partial<FeaturesOctoCapabilities>;
}

export function buildFeaturesOcto(input: BuildFeaturesOctoInput): FeaturesOcto {
  let built: FeaturesOcto;

  if (!input.enabled) {
    built = {
      version: FEATURES_OCTO_VERSION,
      enabled: false,
      adapters: [],
      capabilities: { ...DEFAULT_FEATURES_OCTO_CAPABILITIES },
    };
  } else {
    const seen = new Set<string>();
    const deduped: AdapterType[] = [];
    for (const adapter of input.adapters) {
      if (!Value.Check(AdapterTypeSchema, adapter)) {
        throw new Error(
          `buildFeaturesOcto: unknown adapter name ${JSON.stringify(adapter)}; ` +
            `expected one of structured_subagent, cli_exec, pty_tmux, structured_acp`,
        );
      }
      if (seen.has(adapter)) {
        continue;
      }
      seen.add(adapter);
      deduped.push(adapter);
    }

    built = {
      version: FEATURES_OCTO_VERSION,
      enabled: true,
      adapters: deduped,
      capabilities: {
        ...DEFAULT_FEATURES_OCTO_CAPABILITIES,
        ...input.capabilities,
      },
    };
  }

  if (!Value.Check(FeaturesOctoSchema, built)) {
    const errors = [...Value.Errors(FeaturesOctoSchema, built)]
      .map((e) => `${e.path} ${e.message}`)
      .join("; ");
    throw new Error(`buildFeaturesOcto: built descriptor failed schema check: ${errors}`);
  }

  return built;
}
