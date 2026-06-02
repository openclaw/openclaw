import { hasFlag } from "../argv.js";
import { cliCommandCatalog, type CliCommandCatalogEntry } from "../command-catalog.js";
import { matchesCommandPath } from "../command-path-matches.js";
import { resolveCliCommandPathPolicy } from "../command-path-policy.js";
import {
  routedCommandDefinitions,
  type AnyRoutedCommandDefinition,
} from "./routed-command-definitions.js";

export type RouteSpec = {
  /** Returns true when the resolved command path belongs to this route. */
  matches: (path: string[]) => boolean;
  /** Optional raw argv guard for routes that only support a subset of flags. */
  canRun?: (argv: string[]) => boolean;
  /** Whether plugin preload is required before running this route. */
  loadPlugins?: boolean | ((argv: string[]) => boolean);
  /** Execute the route and return false when argv no longer parses. */
  run: (argv: string[]) => Promise<boolean>;
};

/** Resolve route-specific plugin preload policy from the command catalog. */
function createCommandLoadPlugins(commandPath: readonly string[]): (argv: string[]) => boolean {
  return (argv) => {
    const loadPlugins = resolveCliCommandPathPolicy([...commandPath]).loadPlugins;
    return loadPlugins === "always" || (loadPlugins === "text-only" && !hasFlag(argv, "--json"));
  };
}

/** Convert a catalog route definition into the executable route spec. */
function createParsedRoute(params: {
  entry: CliCommandCatalogEntry;
  definition: AnyRoutedCommandDefinition;
}): RouteSpec {
  return {
    matches: (path) =>
      matchesCommandPath(path, params.entry.commandPath, { exact: params.entry.exact }),
    canRun: (argv) => Boolean(params.definition.parseArgs(argv)),
    loadPlugins: params.entry.route?.preloadPlugins
      ? createCommandLoadPlugins(params.entry.commandPath)
      : undefined,
    run: async (argv) => {
      const args = params.definition.parseArgs(argv);
      if (!args) {
        return false;
      }
      await params.definition.runParsedArgs(args as never);
      return true;
    },
  };
}

/** Route table generated from the CLI command catalog and typed route definitions. */
export const routedCommands: RouteSpec[] = cliCommandCatalog
  .filter(
    (
      entry,
    ): entry is CliCommandCatalogEntry & { route: { id: keyof typeof routedCommandDefinitions } } =>
      Boolean(entry.route),
  )
  .flatMap((entry) => {
    const definition = routedCommandDefinitions[entry.route.id];
    return definition ? [createParsedRoute({ entry, definition })] : [];
  });
