# Update owner

`src/update/` owns updates of Git checkouts and npm, pnpm and Bun global installs on Linux, macOS and Windows. The Gateway's `update.run` and `openclaw update` both call it. The flow and the rules for changes are in the [update implementation contract](../../docs/install/updating.md#update-implementation-contract); read it before you change update behavior.

| File                                   | Step                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `preflight.ts`                         | Refuses before any change, with the reason.                                                            |
| `prepare-git.ts`, `prepare-package.ts` | Build the target in its own release directory while the current Gateway serves.                        |
| `check-release.ts`                     | The new release checks its config and plugin surfaces from the directory it serves from.               |
| `run.ts`, `store.ts`                   | Publish the release, write the trial record, ask for one restart.                                      |
| `launcher.ts`                          | Resident launcher: starts the trial, commits on ready, rolls back. Frozen source; Node built-ins only. |
| `gateway-trial.ts`                     | The Gateway after the switch records the outcome.                                                      |
| `convert-service.ts`                   | The first update of a shipped install rebinds its service to the launcher one time.                    |

- Fix release-update behavior here, not in the legacy update code. The legacy code and its limits are in [the bridge rules](../cli/update-cli/AGENTS.md).
- When you fix the legacy code for a behavior that release updates also have, fix it here in the same PR. #203578 added a refusal for a node service that holds the state database to the legacy path only.
