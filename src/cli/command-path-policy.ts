import { expectDefined } from "@openclaw/normalization-core";
import { getCommandPathWithRootOptions } from "./argv.js";
import type { CliCommandPathPolicy, CliNetworkProxyPolicy } from "./command-catalog-types.js";
import { cliCommandCatalog } from "./command-catalog.js";
import { matchesCommandPath } from "./command-path-matches.js";
import { resolveGatewayCommandPath } from "./gateway-run-argv.js";
import { resolveCliParentCommandPath } from "./parent-command-path.js";

const DEFAULT_CLI_COMMAND_PATH_POLICY: CliCommandPathPolicy = {
  configGuard: "run",
  stateStoreGuard: "skip",
  loadPlugins: "never",
  pluginRegistry: { scope: "all" },
  ownsProtocolStdout: false,
  hideBanner: false,
  ensureCliPath: true,
  networkProxy: "default",
};

export function resolveCliCommandPathPolicy(commandPath: string[]): CliCommandPathPolicy {
  // Later catalog entries can refine broader root policies with exact subcommand overrides.
  const resolvedPolicy: CliCommandPathPolicy = { ...DEFAULT_CLI_COMMAND_PATH_POLICY };
  for (const entry of cliCommandCatalog) {
    if (!entry.policy) {
      continue;
    }
    if (!matchesCommandPath(commandPath, entry.commandPath, { exact: entry.exact })) {
      continue;
    }
    Object.assign(resolvedPolicy, entry.policy);
  }
  return resolvedPolicy;
}

export function resolveCliNetworkProxyPolicy(argv: string[]): CliNetworkProxyPolicy {
  // Gateway `run openclaw ...` argv needs catalog routing against the embedded command path.
  const tokens =
    resolveGatewayCommandPath(argv) ??
    resolveCliParentCommandPath(argv) ??
    getCommandPathWithRootOptions(argv, argv.length);
  let commandPath: string[] = [];
  if (tokens.length > 0) {
    let bestMatch: readonly string[] | null = null;
    for (const entry of cliCommandCatalog) {
      if (!matchesCommandPath(tokens, entry.commandPath)) {
        continue;
      }
      if (!bestMatch || entry.commandPath.length > bestMatch.length) {
        bestMatch = entry.commandPath;
      }
    }
    commandPath = bestMatch ? [...bestMatch] : [expectDefined(tokens[0], "tokens entry at 0")];
  }
  const networkProxy = resolveCliCommandPathPolicy(commandPath).networkProxy;
  return typeof networkProxy === "function" ? networkProxy({ argv, commandPath }) : networkProxy;
}
