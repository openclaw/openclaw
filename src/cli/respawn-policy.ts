import { getPrimaryCommand, hasHelpOrVersion } from "./argv.js";

/**
 * Commands that use experimental Node.js APIs (e.g. node:sqlite) and benefit
 * from `--disable-warning=ExperimentalWarning`. Only these commands trigger a
 * process respawn; all other short-lived CLI commands skip it to avoid ~1-2s
 * of startup overhead.
 *
 * NOTE: `status` is intentionally absent even though it can reach node:sqlite
 * transitively. All node:sqlite access goes through `requireNodeSqlite()`
 * (src/memory/sqlite.ts), which calls `installProcessWarningFilter()` before
 * loading the module, suppressing the ExperimentalWarning without a respawn.
 * If you add a new direct `import("node:sqlite")` anywhere, either route it
 * through `requireNodeSqlite()` or add the owning command to this set.
 */
const COMMANDS_NEEDING_RESPAWN = new Set([
  // Long-running server — loads node:sqlite for memory/QMD indexing.
  "gateway",
  // Legacy alias for gateway.
  "daemon",
  // Agent turns route through the gateway which uses node:sqlite.
  "agent",
  // Memory CLI directly operates on the SQLite-backed index.
  "memory",
]);

export function shouldSkipRespawnForArgv(argv: string[]): boolean {
  if (hasHelpOrVersion(argv)) {
    return true;
  }

  const primary = getPrimaryCommand(argv);

  // No subcommand (bare `openclaw`) — skip respawn; root help/version is
  // handled above and the bare invocation just prints help.
  if (primary === null) {
    return true;
  }

  // Only respawn for commands known to trigger experimental warnings.
  return !COMMANDS_NEEDING_RESPAWN.has(primary);
}
