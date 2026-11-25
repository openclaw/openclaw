# Legacy update code (bridge)

This directory, `src/infra/update-*`, `src/infra/package-update-*` and `src/gateway/server-methods/update.ts` hold the in-place updater from v2026.11.7, v2026.11.10-beta.1 and earlier. Owned installs no longer update through it: they use [`src/update/`](../../update/AGENTS.md). While the release path landed on 2026-11-22 and 2026-11-23, five update fixes changed only this code (#203529, #203555, #203486, #203578, #203849) and no file in `src/update/`.

## What still runs here

- **Shipped updaters' first update.** A shipped updater updates to a new release in place, with its own code, and then calls into the new release: the migrated-finalize worker (`--check` and its capabilities), candidate `update` with `OPENCLAW_UPDATE_POST_CORE=1`, the `dist/cli/daemon-cli.js` exports, and the compatibility chunks recorded in `scripts/lib/update-compat-inventory.json`. These are shipped contracts.
- **Routes not moved yet:** `openclaw update --dry-run`, channel switches between a Git checkout and a package, a package update to `--tag main`, immutable installs, `update repair`, `update status`, and the legacy recovery admission (`assertUpdateRecoveryAdmission`).
- Gateway `update.*` methods other than `update.run`.

## Rules

- Add no features here. A change names the route above that it serves.
- A fix to a behavior that release updates also have lands in `src/update/` in the same PR.
- A fix to the steps a shipped updater runs before the new release starts reaches its users only through a backport to their stable line (v2026.11.7 carried #203097 and #202370). On `main` alone it changes only the routes above. Name the target stable line in the PR.
- Never weaken a shipped contract (capability fields, exports, inventory entries) to make a cut pass. Cut less.
- Removal order: move the routes not moved yet to `src/update/`. When the oldest supported upgrade source updates through `src/update/`, delete the bridge.
