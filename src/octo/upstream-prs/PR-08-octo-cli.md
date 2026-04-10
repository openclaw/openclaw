# Upstream PR 8 — Register `octo` as a top-level `openclaw` CLI subcommand

**Status:** draft (M0-22). Not yet filed.
**Target repository:** `openclaw/openclaw`
**Target branch:** `main`
**Target files:**

- `src/cli/program/subcli-descriptors.ts` (metadata entry)
- `src/cli/program/register.subclis.ts` (dispatch entry)
  **Pin:** upstream commit `9ece252` (package.json 2026.4.7-1, deployed reference OpenClaw 2026.4.8). This PR is authored against that baseline; rebase and re-verify against the current `main` tip before filing.

---

## Summary

Register `octo` as a top-level subcommand of the `openclaw` CLI binary so that `openclaw octo <subcommand>` dispatches into the Octopus Orchestrator CLI surface. This PR wires the top-level DISPATCH only. The individual verb handlers (`status`, `mission`, `arm`, `grip`, `claims`, `events`, `node`, `init`, `doctor`) are scaffolded under `src/octo/cli/` and land in later octo milestones as `src/octo/cli/octo-*.ts` modules; this change is the entry point that makes them reachable from argv.

When `octo.enabled: false` (the default through Milestone 1), `openclaw octo *` returns a clear, subsystem-specific error — not a generic "unknown command". The binary knows `octo` exists; it is simply disabled.

## Rationale

- **Operator surface parity with LLD §Operator Surfaces.** The LLD specifies the full `openclaw octo` verb set (`status`, `mission`, `arm`, `grip`, `claims`, `events`, `node`, `init`, `doctor`). Those verbs need a registered top-level command to attach to. Without this PR, there is nowhere for the per-verb handlers to land.
- **Declarative registry, minimal churn.** All existing top-level CLIs (`acp`, `gateway`, `cron`, `nodes`, `node`, `skills`, …) are registered through two files: a descriptor catalog in `subcli-descriptors.ts` (name + description + `hasSubcommands`) and a lazy-import entry in `register.subclis.ts` (module loader + exported `registerXxxCli`). Adding `octo` follows that exact shape — one descriptor row, one lazy-loader row — matching the pattern used by every other subsystem CLI in the tree.
- **Lazy loading preserves startup cost.** The `defineImportedProgramCommandGroupSpecs` path imports the CLI module only when its command name is on argv. Adding an `octo` entry does not affect cold-start latency for unrelated invocations (`openclaw gateway run`, `openclaw status`, etc.).
- **Feature-flag gating at dispatch, not at registration.** Matching the pattern established by PR 1 (method list) and PR 4 (slash command registration), the command NAME is advertised regardless of `octo.enabled`. The gate is enforced inside the handler: when `octo.enabled: false`, the handler prints `"Octopus Orchestrator is not enabled. Set octo.enabled: true in openclaw.json."` to stderr and exits non-zero. Operators never see "unknown command" for a documented verb.
- **Single source of truth for help text.** Registering `octo` in the descriptor catalog means `openclaw --help` and shell completion pick it up automatically via `getSubCliEntries()`. No parallel help/completion wiring is required.

## Expected changes

Two small edits, one per file:

1. **`src/cli/program/subcli-descriptors.ts`** — add one descriptor row in the catalog array:

   ```ts
   {
     name: "octo",
     description: "Octopus Orchestrator control plane (missions, arms, grips)",
     hasSubcommands: true,
   },
   ```

   Placement is alphabetically adjacent to `nodes`/`node` in the existing block, matching the loose grouping already present in the file (related commands neighbor each other).

2. **`src/cli/program/register.subclis.ts`** — add one lazy-loader entry inside the first `defineImportedProgramCommandGroupSpecs([...])` block:

   ```ts
   {
     commandNames: ["octo"],
     loadModule: () => import("../octo-cli.js"),
     exportName: "registerOctoCli",
   },
   ```

   The loader targets `src/cli/octo-cli.ts`, which is the thin adapter module that re-exports `registerOctoCli` from `src/octo/cli/index.ts`. Creation of `src/cli/octo-cli.ts` and the `src/octo/cli/index.ts` entry point is out of scope for this PR and lands in the follow-up milestone that introduces the first verb handler (`octo status`).

Until that follow-up lands, the `loadModule` import resolves to a stub whose `registerOctoCli(program)` registers the nine subcommand names with a shared disabled-action that prints the feature-flag error message. This keeps the CLI surface coherent: `openclaw octo --help` lists the verbs, and invoking any of them prints the gating error rather than Commander's default "unknown command".

## Diff preview

See `PR-08.patch` for the full diff. Shape is two files, two additions.

## Test plan

- `pnpm test` — existing CLI registration tests (`register.subclis.test.ts`, `command-registry.test.ts`) must continue to pass. Add a case asserting that `getSubCliEntries()` contains an entry with `name === "octo"` and `hasSubcommands === true`.
- Manual, `octo.enabled: false`: `openclaw octo status` must print `"Octopus Orchestrator is not enabled. Set octo.enabled: true in openclaw.json."` to stderr and exit non-zero. `openclaw --help` must list `octo` alongside other subsystem CLIs.
- Manual, `octo.enabled: true`: `openclaw octo status` must dispatch into the handler (stub or real, depending on milestone ordering) without hitting the disabled path.
- Completion: `openclaw completion bash | grep -w octo` must show the verb in the generated completion script.

## Rollback plan

Revert the two additions. No persisted state, no config migration, no downstream consumers. The `src/octo/cli/` scaffold directory remains (it is already referenced by HLD §"Code layout") and is simply unreachable from argv until re-registered.

## Dependencies on other PRs

- **Logically depends on PR 1** (`octo.*` method names visible via `listGatewayMethods()`) because the eventual handlers in `src/octo/cli/octo-*.ts` call into those methods. This PR does not call them directly, so the dependency is soft — this PR can land first without breakage.
- **Independent of PR 4** (`/octo` slash registration). The two operator surfaces (CLI and in-chat slash) are parallel and do not share code paths.

## Reviewer guidance

Reviewer does NOT need to understand the full Octopus Orchestrator design to merge this PR. The only question is: "should `octo` be a top-level CLI verb registered through the same lazy-import registry as every other subsystem CLI?" The answer is yes; the alternative is a parallel dispatch path, which drifts from the existing pattern.

For full Octopus context: `docs/octopus-orchestrator/HLD.md` §"Code layout and module boundaries", `docs/octopus-orchestrator/LLD.md` §"Operator Surfaces", `docs/octopus-orchestrator/DECISIONS.md` (OCTO-DEC-027 for the feature flag).
