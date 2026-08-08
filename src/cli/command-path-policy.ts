import { expectDefined } from "@openclaw/normalization-core";
// Resolves CLI command path policy from the declarative command catalog.
import { resolveCliStartupCommandPath } from "./argv-invocation.js";
import { getCommandPathWithRootOptions } from "./argv.js";
import {
  cliCommandCatalog,
  type CliCommandPathPolicy,
  type CliNetworkProxyPolicy,
} from "./command-catalog.js";
import { matchesCommandPath } from "./command-path-matches.js";
import { resolveGatewayCatalogCommandPath } from "./gateway-run-argv.js";

const DEFAULT_CLI_COMMAND_PATH_POLICY: CliCommandPathPolicy = {
  configGuard: "run",
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

function isCommandPathPrefix(commandPath: string[], pattern: readonly string[]): boolean {
  return pattern.every((segment, index) => commandPath[index] === segment);
}

export function resolveCliCatalogCommandPath(argv: string[]): string[] {
  // Gateway `run openclaw ...` argv needs catalog routing against the embedded command path.
  const startupPath = resolveCliStartupCommandPath(argv);
  const rawTokens =
    resolveGatewayCatalogCommandPath(argv) ??
    (startupPath[0] === "agent" ? startupPath : getCommandPathWithRootOptions(argv, argv.length));
  // Commander canonicalizes the public `capability` alias to `infer`; do the same for the
  // pre-registration config read so aliases inherit the catalog's exact inspection policy.
  const tokens = rawTokens[0] === "capability" ? ["infer", ...rawTokens.slice(1)] : rawTokens;
  if (tokens.length === 0) {
    return [];
  }
  let bestMatch: readonly string[] | null = null;
  for (const entry of cliCommandCatalog) {
    if (!isCommandPathPrefix(tokens, entry.commandPath)) {
      continue;
    }
    if (!bestMatch || entry.commandPath.length > bestMatch.length) {
      bestMatch = entry.commandPath;
    }
  }
  return bestMatch ? [...bestMatch] : [expectDefined(tokens[0], "tokens entry at 0")];
}

export function resolveCliNetworkProxyPolicy(argv: string[]): CliNetworkProxyPolicy {
  const commandPath = resolveCliCatalogCommandPath(argv);
  const networkProxy = resolveCliCommandPathPolicy(commandPath).networkProxy;
  return typeof networkProxy === "function" ? networkProxy({ argv, commandPath }) : networkProxy;
}
