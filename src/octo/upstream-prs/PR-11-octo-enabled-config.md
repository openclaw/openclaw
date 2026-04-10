# Upstream PR 11 — Wire `loadOctoConfig` into the core config loader

**Status:** draft (M0-25). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target files:**

- `src/config/io.ts` (dispatch site inside `loadConfig()`)
- `src/config/types.openclaw.ts` (new optional `octo?: OctoConfig` field on `OpenClawConfig`)

**Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Teach the core OpenClaw config loader about the `octo:` block at the root of `openclaw.json`. When the block is present, `loadConfig()` dispatches to `loadOctoConfig()` from `src/octo/config/loader.ts` (landed in M0-11) to produce a validated `OctoConfig`, which is then attached to the resolved `OpenClawConfig` under a new optional `octo` field. When the block is absent, the loader resolves to the default descriptor `{ enabled: false, ... }` and no Octopus runtime state is touched.

This is the last upstream PR in the Milestone 0 wave whose job is purely to plumb the feature flag surface — no behavior changes, no new schema, no new files. It is the config-layer counterpart to PR-01 (method surface) and PR-02 (`features.octo` advertiser): together they ensure that when a Gateway binary carrying the octo subsystem starts up, the subsystem is either fully dormant (default) or fully configured and validated (opt-in) with nothing in between.

## Rationale

- **Single source of truth for the `octo:` subtree.** The octo config schema lives in `src/octo/config/schema.ts` (M0-06) and is loaded via `loadOctoConfig` (M0-11). The core config loader does NOT redefine or re-validate the schema. It extracts `rawOpenclawConfig.octo` (via the already-parsed root object), hands it to `loadOctoConfig`, and stores the validated result. When the octo schema evolves, only `src/octo/config/schema.ts` changes — the core loader keeps working unchanged.
- **`loadOctoConfig` is pure and does not touch disk.** Per `src/octo/config/loader.ts` header comment, the loader accepts a `Readonly<Record<string, unknown>>` (the parsed openclaw.json root) and returns an `OctoConfig`. All file I/O, env substitution, `$include` resolution, and legacy migration are already done by the core loader upstream of this dispatch point. The octo loader is a validate-and-merge step, not a parallel file reader. This keeps the octo subsystem cleanly scoped to `src/octo/` with no risk of diverging from the core loader's read semantics (dotenv, env substitution, include resolution, recovery, etc.).
- **Default `{ enabled: false }` is a complete no-op.** Per OCTO-DEC-027 and CONFIG.md §Feature flag, when the `octo:` block is missing from `openclaw.json`, `loadOctoConfig` returns a shallow clone of `DEFAULT_OCTO_CONFIG` whose `enabled` field is `false`. With `enabled: false`:
  - No Octopus state directories are created (state-path materialization is gated on `enabled === true` inside the octo subsystem — not in the core loader).
  - `octo.*` Gateway methods return a structured `not_enabled` error at dispatch time (per PR-01 and OCTO-DEC-027 — method names are listed at introspection time but handlers refuse to run).
  - The `openclaw octo ...` CLI dispatch (landing in a later PR) bails out before entering the subsystem.
  - `features.octo` still appears in the `hello-ok` handshake (per PR-02) but reports `enabled: false` to clients.
    The subsystem is completely dormant. Existing deployments on `2026.4.8` upgrade with zero behavior change until an operator explicitly adds an `octo:` block with `enabled: true`.
- **Strict validation on malformed input, no silent fallback.** Per CONFIG.md §Validation ("No silent fallback to defaults on invalid keys") and the rest of the core loader's strict-validation policy, a malformed `octo:` block (wrong shape, unknown keys in strict mode, schema violations) causes startup to fail with a clear error message. `loadOctoConfig` already throws with a formatted validation summary; the dispatch site re-throws, and the existing `loadConfig` try/catch converts the error into a `throwInvalidConfig`-style fatal per the INVALID_CONFIG code path. Operators see exactly which octo key failed, not a silent revert to defaults.
- **Symmetric with existing subsystem plumbing.** The resolved `OpenClawConfig` already carries per-subsystem configs (`channels`, `cron`, `tools`, `hooks`, `memory`, `mcp`, `gateway`, …). Adding `octo?: OctoConfig` is the one-line type change that makes the octo subsystem a peer of these existing subsystems and lets downstream code read `cfg.octo` with the same ergonomics as `cfg.cron`.

## Expected changes

### `src/config/types.openclaw.ts`

1. **Add a type import** for `OctoConfig` from `src/octo/config/schema.ts`. NodeNext resolution — `.js` suffix even though the source is `.ts`.
2. **Append an optional `octo?: OctoConfig` field** on the `OpenClawConfig` type, alongside the other subsystem config fields (`channels`, `cron`, `tools`, `hooks`, `memory`, `mcp`). Placement at the end matches the "new subsystems append" convention already used in that file.

### `src/config/io.ts`

3. **Add an import** for `loadOctoConfig` from `src/octo/config/loader.ts`.
4. **Dispatch inside `loadConfig()`**, immediately after `materializeRuntimeConfig` has produced `cfg` and before the duplicate-agent-dir check. The dispatch hands the already-validated runtime config to `loadOctoConfig` and writes the result back onto `cfg.octo`. On validation failure, `loadOctoConfig` throws; the existing `loadConfig` try/catch surfaces it as a fatal startup error (matching how duplicate-agent-dir and invalid-config errors already fail closed).

Note: `loadOctoConfig` is passed the runtime-shaped config object. It only reads the `octo` subtree, so whether it receives the pre-materialize or post-materialize shape is immaterial — no other subsystem's defaults are visible to the octo validation path. Passing the post-`materializeRuntimeConfig` object keeps the dispatch site a single line and ensures the octo block sees the same env-substituted, include-resolved values as every other subsystem.

## Diff preview

See `PR-11.patch` for the full patch.

## Test plan

- `pnpm test` — existing config loader tests must continue to pass unchanged (default path: no `octo:` block, `cfg.octo.enabled === false`).
- Add a unit test for `loadConfig()`: given a fixture `openclaw.json` with `{ octo: { enabled: true } }`, assert `cfg.octo.enabled === true`.
- Add a unit test for the failure path: given a fixture with a malformed `octo:` block (e.g. `{ octo: { enabled: "yes" } }`), assert `loadConfig()` throws and the error message mentions the failing path.
- Existing `src/octo/config/loader.test.ts` continues to cover the `loadOctoConfig` function in isolation; this PR only covers the dispatch wiring.
- Manual: start a gateway with no `octo:` block and verify no state dirs are created under `state/octo/`, no INFO line beyond the existing `octopus orchestrator: enabled=false` startup marker, and `hello-ok.features.octo.enabled === false`.

## Rollback plan

Revert the import + dispatch line in `src/config/io.ts` and the `octo?` field on `OpenClawConfig` in `src/config/types.openclaw.ts`. `loadOctoConfig` and the octo config schema stay in place — they are already used by octo-internal code and tests. Rollback strictly removes the wiring between the core loader and the octo subsystem.

## Dependencies on other PRs

- **Depends on M0-11** — `loadOctoConfig` must exist and be exported from `src/octo/config/loader.ts` with the signature `(rawOpenclawConfig, opts?) => OctoConfig`. Landed.
- **Depends on M0-06** — `OctoConfig` type and `OctoConfigSchema` must exist in `src/octo/config/schema.ts`. Landed.
- **Independent of PR-01 through PR-10.** This PR can land in any order relative to the other upstream PRs. It adds the `cfg.octo` read surface that downstream PRs (CLI dispatch, cron job types, hook handlers, tool registry) will consume, but does not require them to exist first.

## Reviewer guidance

The reviewer does not need to understand the full Octopus Orchestrator design to merge this PR. The only questions are:

1. "Should the core config loader be aware of the `octo:` block?" Yes — per INTEGRATION.md row 9, this is the single plumbing point that lets every downstream PR read `cfg.octo` without re-parsing the raw config.
2. "Does this change anything for deployments that don't set `octo:`?" No — the default is `{ enabled: false }` and every octo code path gates on `enabled === true` before doing any work.
3. "Is the schema redefined here?" No — the dispatch imports `loadOctoConfig`, which imports `OctoConfigSchema` from `src/octo/config/schema.ts`. The core loader holds zero octo validation logic.

For full Octopus context: `docs/octopus-orchestrator/HLD.md`, `docs/octopus-orchestrator/CONFIG.md` §Feature flag, `docs/octopus-orchestrator/DECISIONS.md` OCTO-DEC-027 (feature flag rationale).
