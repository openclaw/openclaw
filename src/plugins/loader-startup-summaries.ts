import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { formatPluginFailureSummary } from "./loader-records.js";
import type { PluginLoadOptions } from "./loader-types.js";
import type { PluginRegistry } from "./registry-types.js";

type SummaryLogger = NonNullable<PluginLoadOptions["logger"]>;

/** The two load-context flags that decide whether a load reports at all. */
type StartupSummaryGate = {
  shouldActivate: boolean;
  runtimeSideEffects: boolean;
};

/**
 * One grouped line per failure class, emitted once per load instead of per
 * plugin. These are the only loader messages an operator reads during startup,
 * so each one has to name the plugins and the command that explains them.
 *
 * Validate and metadata loads stay silent. The blocked-hook summary also has to
 * reach a `runtimeSideEffects` load that does not activate: that is exactly how
 * `loadGatewayPlugins` loads at Gateway startup, which is the one load an
 * operator actually watches. Inspection loads set neither flag.
 */
export function emitPluginStartupSummaries(
  registry: PluginRegistry,
  logger: SummaryLogger,
  gate: StartupSummaryGate,
  mode: PluginLoadOptions["mode"],
): void {
  if (mode === "validate" || mode === "cli-metadata") {
    return;
  }
  if (gate.shouldActivate) {
    const failedPlugins = registry.plugins.filter((plugin) => plugin.failedAt != null);
    if (failedPlugins.length > 0) {
      logger.warn(
        `[plugins] ${failedPlugins.length} plugin(s) failed to initialize (${formatPluginFailureSummary(
          failedPlugins,
        )}). Run 'openclaw plugins inspect <id> --runtime --json' for runtime diagnostics and 'openclaw plugins list' for registry state. After fixing plugin code or load paths, run 'openclaw plugins reload <id>' to retry.`,
      );
    }
  }
  if (!gate.shouldActivate && !gate.runtimeSideEffects) {
    return;
  }
  const blockedHookPluginIds = uniqueValues(
    registry.blockedHooks
      .filter((entry) => entry.severity === "error")
      .map((entry) => entry.pluginId),
  );
  if (blockedHookPluginIds.length > 0) {
    logger.error(
      `[plugins] hook registrations blocked for ${blockedHookPluginIds.length} plugin(s) (${blockedHookPluginIds.join(", ")}); those handlers will never run. Run '/status plugins' or 'openclaw plugins inspect <id> --runtime --json' for the blocked hook names and the config key that unblocks each one.`,
    );
  }
}
