import { theme } from "../../packages/terminal-core/src/theme.js";
import { defaultRuntime } from "../runtime.js";
import { ExpectedCliError } from "./failure-output.js";
import type { PluginMarketplaceListOptions } from "./plugins-cli.js";
import { formatVersionLabel } from "./version-format.js";

/** List plugins from a configured marketplace manifest. */
export async function runPluginMarketplaceListCommand(
  source: string,
  opts: PluginMarketplaceListOptions,
): Promise<void> {
  const { listMarketplacePlugins } = await import("../plugins/marketplace.js");
  const { createPluginInstallLogger, quietPluginJsonLogger } =
    await import("./plugins-command-helpers.js");
  const result = await listMarketplacePlugins({
    marketplace: source,
    logger: opts.json ? quietPluginJsonLogger : createPluginInstallLogger(),
  });
  if (!result.ok) {
    const message = result.error;
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }

  if (opts.json) {
    return defaultRuntime.writeJson({
      source: result.sourceLabel,
      name: result.manifest.name,
      version: result.manifest.version,
      plugins: result.manifest.plugins,
    });
  }

  if (result.manifest.plugins.length === 0) {
    defaultRuntime.log(`No plugins found in marketplace ${result.sourceLabel}.`);
    return;
  }

  defaultRuntime.log(
    `${theme.heading("Marketplace")} ${theme.muted(result.manifest.name ?? result.sourceLabel)}`,
  );
  for (const plugin of result.manifest.plugins) {
    const suffix = plugin.version ? theme.muted(` ${formatVersionLabel(plugin.version)}`) : "";
    const desc = plugin.description ? ` - ${theme.muted(plugin.description)}` : "";
    defaultRuntime.log(`${theme.command(plugin.name)}${suffix}${desc}`);
  }
}
