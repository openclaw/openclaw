import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { ClawHubPackageSearchResult } from "../infra/clawhub-packages.js";
import { formatErrorMessage } from "../infra/errors.js";
import { searchInstallablePluginPackages } from "../plugins/catalog-search.js";
import { isBareNpmPackageName } from "../plugins/install-source-spec.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "./command-format.js";
import { ExpectedCliError } from "./failure-output.js";
import { formatVersionLabel } from "./version-format.js";

export type PluginsSearchOptions = {
  json?: boolean;
  limit?: number;
};

function formatPackageSearchLine(entry: ClawHubPackageSearchResult): string {
  const pkg = entry.package;
  // A selector keeps legacy unscoped results from resolving as local plugin-ID shortcuts.
  const installSpec = isBareNpmPackageName(pkg.name) ? `${pkg.name}@latest` : pkg.name;
  const flags = [
    pkg.family,
    pkg.channel,
    pkg.isOfficial && pkg.channel !== "official" ? "official" : undefined,
    pkg.latestVersion ? formatVersionLabel(pkg.latestVersion) : undefined,
  ].filter(Boolean);
  const summary = pkg.summary ? theme.muted(` — ${sanitizeTerminalText(pkg.summary)}`) : "";
  return `${sanitizeTerminalText(pkg.name)}  ${theme.muted(flags.join(" | "))}${summary}\n  ${theme.muted(`Install: ${formatCliCommand(`openclaw plugins install ${sanitizeTerminalText(installSpec)}`)}`)}`;
}

export async function runPluginsSearchCommand(
  queryParts: string[] | string,
  opts: PluginsSearchOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const query = normalizeOptionalString(
    Array.isArray(queryParts) ? queryParts.join(" ") : queryParts,
  );
  if (!query) {
    const message = "Usage: openclaw plugins search <query>";
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }

  try {
    const results = await searchInstallablePluginPackages({ query, limit: opts.limit });

    if (opts.json) {
      writeRuntimeJson(runtime, { results });
      return;
    }
    if (results.length === 0) {
      runtime.log("No ClawHub plugins found.");
      return;
    }
    runtime.log(`${theme.heading("ClawHub plugins")} ${theme.muted(`(${results.length})`)}`);
    runtime.log(results.map(formatPackageSearchLine).join("\n"));
  } catch (error) {
    if (opts.json) {
      throw error;
    }
    runtime.error(formatErrorMessage(error));
    runtime.exit(1);
  }
}
