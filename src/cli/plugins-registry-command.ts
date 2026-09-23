// Metadata-only inspection and repair of the persisted plugin registry.
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { getRuntimeConfig } from "../config/config.js";
import { createConfigIO } from "../config/io.factory.js";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
} from "../config/io.invalid-config.js";
import { createManagedRuntimeEnvBase } from "../config/io.read-helpers.js";
import { resolveStateDir } from "../config/paths.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import { formatCliJsonFailure } from "./failure-output.js";
import { exitCliAfterOutput } from "./one-shot-exit.js";

export type PluginRegistryOptions = {
  json?: boolean;
  refresh?: boolean;
};

function countEnabledPlugins(plugins: readonly { enabled: boolean }[]): number {
  return plugins.filter((plugin) => plugin.enabled).length;
}

function formatRegistryState(state: "missing" | "fresh" | "stale"): string {
  return state === "fresh" ? theme.success(state) : theme.warn(state);
}

/** Inspect or refresh the persisted plugin registry index. */
export async function runPluginsRegistryCommand(opts: PluginRegistryOptions): Promise<void> {
  const { inspectPluginRegistry } = await import("../plugins/plugin-registry.js");

  const formatDifferences = (
    differences: Awaited<ReturnType<typeof inspectPluginRegistry>>["differences"],
  ) => {
    const formatSource = (source: string | null) =>
      source ? sanitizeTerminalText(shortenHomePath(source)) : "missing";
    return differences.map(
      (difference) =>
        `${sanitizeTerminalText(difference.pluginId)}: ${difference.changed.join("+")} changed; persisted ${formatSource(difference.persistedSource)}; derived ${formatSource(difference.derivedSource)}`,
    );
  };

  if (opts.refresh) {
    const { refreshPluginRegistry } = await import("../plugins/plugin-registry-refresh.js");
    return await withPluginLifecycleLease({}, async (lease) => {
      // Stale registry metadata can invalidate plugin config before this repair runs.
      // Read current source policy without consulting that projection or recovering the file.
      const snapshot = await createConfigIO({
        env: createManagedRuntimeEnvBase(),
        observe: false,
        pluginValidation: "core-only",
      }).readConfigFileSnapshot();
      lease.assertOwned();
      if (!snapshot.valid) {
        throw createInvalidConfigError(snapshot.path, formatInvalidConfigDetails(snapshot.issues));
      }
      const { migrateLegacyInstalledPluginIndex } =
        await import("../infra/state-migrations.plugin-state.js");
      lease.assertOwned();
      // Core-only admission skips Doctor; retain its canonical ownership import before replacement.
      const migration = await migrateLegacyInstalledPluginIndex({
        stateDir: resolveStateDir(),
        lease,
      });
      lease.assertOwned();
      if (migration.warnings.length > 0) {
        throw new Error(
          `Plugin installation metadata migration did not complete: ${migration.warnings.join("; ")}. Run openclaw doctor --fix before refreshing the registry.`,
        );
      }
      const config = snapshot.runtimeConfig;
      const index = await refreshPluginRegistry({
        config,
        reason: "manual",
        filePath: lease.databasePath,
        lease,
      });
      const inspection = await inspectPluginRegistry({ config });
      lease.assertOwned();
      if (inspection.state !== "fresh") {
        const differenceLines = formatDifferences(inspection.differences);
        const message = [
          "Plugin registry refresh could not verify the persisted replacement.",
          ...differenceLines.map((difference) => `- ${difference}`),
          "Stop plugin package changes, then run `openclaw plugins registry --refresh` again.",
        ].join("\n");
        if (opts.json) {
          defaultRuntime.writeJson({
            ...formatCliJsonFailure(message),
            refreshed: false,
            state: inspection.state,
            refreshReasons: inspection.refreshReasons,
            differences: inspection.differences,
          });
          exitCliAfterOutput(defaultRuntime, 1);
        }
        throw new Error(message);
      }
      if (opts.json) {
        defaultRuntime.writeJson({
          refreshed: true,
          state: inspection.state,
          refreshReasons: inspection.refreshReasons,
          differences: inspection.differences,
          registry: index,
        });
        return;
      }
      const total = index.plugins.length;
      const enabled = countEnabledPlugins(index.plugins);
      defaultRuntime.log(`Plugin registry refreshed: ${enabled}/${total} enabled plugins indexed.`);
    });
  }

  const inspection = await inspectPluginRegistry({ config: getRuntimeConfig() });
  if (opts.json) {
    defaultRuntime.writeJson({
      state: inspection.state,
      refreshReasons: inspection.refreshReasons,
      differences: inspection.differences,
      persisted: inspection.persisted,
      current: inspection.current,
    });
    return;
  }

  const currentTotal = inspection.current.plugins.length;
  const currentEnabled = countEnabledPlugins(inspection.current.plugins);
  const persistedTotal = inspection.persisted?.plugins.length ?? 0;
  const persistedEnabled = inspection.persisted
    ? countEnabledPlugins(inspection.persisted.plugins)
    : 0;
  const lines = [
    `${theme.muted("State:")} ${formatRegistryState(inspection.state)}`,
    `${theme.muted("Current:")} ${currentEnabled}/${currentTotal} enabled plugins`,
    `${theme.muted("Persisted:")} ${persistedEnabled}/${persistedTotal} enabled plugins`,
  ];
  if (inspection.refreshReasons.length > 0) {
    lines.push(`${theme.muted("Refresh reasons:")} ${inspection.refreshReasons.join(", ")}`);
    lines.push(...formatDifferences(inspection.differences).map((difference) => `- ${difference}`));
    lines.push(`${theme.muted("Repair:")} ${theme.command("openclaw plugins registry --refresh")}`);
  }
  defaultRuntime.log(lines.join("\n"));
}
