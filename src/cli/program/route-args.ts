// Route-first argv parsers for commands that can skip full Commander startup.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { isValueToken } from "../../infra/cli-root-options.js";
import {
  getCommandPositionalsWithRootOptions,
  getFlagValue,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
} from "../argv.js";
import { parseGatewayPortOption } from "../gateway-port-option.js";
import { MODELS_PARENT_BOOLEAN_FLAGS, MODELS_PARENT_VALUE_FLAGS } from "../parent-command-path.js";

function parseRepeatedFlagValues(argv: string[], name: string): string[] | null {
  const values: string[] = [];
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === "--") {
      break;
    }
    if (arg === name) {
      const next = args[i + 1];
      if (next === undefined || !isValueToken(next)) {
        // Invalid fast-path shapes fall back to Commander so its normal errors and help text win.
        return null;
      }
      values.push(next);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1).trim();
      if (!value) {
        return null;
      }
      values.push(value);
    }
  }
  return values;
}

type RoutedCommandArgShape = {
  commandPath: string[];
  booleanFlags?: string[];
  valueFlags?: string[];
};

function getRoutedCommandPositionals(
  argv: string[],
  shape: RoutedCommandArgShape,
): string[] | null {
  if (argv.slice(2).includes("--")) {
    return null;
  }
  return getCommandPositionalsWithRootOptions(argv, shape);
}

function parseRoutedValueFlags(
  argv: string[],
  shape: RoutedCommandArgShape,
): Map<string, string | undefined> | null {
  if (getRoutedCommandPositionals(argv, shape)?.length !== 0) {
    return null;
  }
  const values = new Map<string, string | undefined>();
  for (const flag of shape.valueFlags ?? []) {
    const value = getFlagValue(argv, flag);
    if (value === null) {
      return null;
    }
    values.set(flag, value);
  }
  return values;
}

function parseSinglePositional(
  argv: string[],
  params: {
    commandPath: string[];
    booleanFlags?: string[];
  },
): string | null {
  const positionals = getRoutedCommandPositionals(argv, params);
  if (!positionals || positionals.length !== 1) {
    return null;
  }
  return positionals[0] ?? null;
}

/** Parse `openclaw health` flags for the route-first status family. */
export function parseHealthRouteArgs(argv: string[]) {
  const positionals = getRoutedCommandPositionals(argv, {
    commandPath: ["health"],
    booleanFlags: ["--json", "--verbose", "--debug"],
    valueFlags: ["--timeout"],
  });
  if (!positionals || positionals.length !== 0) {
    return null;
  }
  const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
  if (timeoutMs === null) {
    return null;
  }
  return {
    json: hasFlag(argv, "--json"),
    verbose: getVerboseFlag(argv, { includeDebug: true }),
    timeoutMs,
  };
}

/** Parse `openclaw status` flags without registering the full command tree. */
export function parseStatusRouteArgs(argv: string[]) {
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["status"],
    booleanFlags: ["--json", "--deep", "--all", "--usage", "--verbose", "--debug"],
    valueFlags: ["--timeout", "--agent"],
  });
  if (!values) {
    return null;
  }
  const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
  if (timeoutMs === null) {
    return null;
  }
  const agent = values.get("--agent");
  return {
    json: hasFlag(argv, "--json"),
    deep: hasFlag(argv, "--deep"),
    all: hasFlag(argv, "--all"),
    usage: hasFlag(argv, "--usage"),
    ...(agent !== undefined ? { agent } : {}),
    verbose: getVerboseFlag(argv, { includeDebug: true }),
    timeoutMs,
  };
}

/** Parse `openclaw gateway status` RPC-only flags accepted by the fast route. */
export function parseGatewayStatusRouteArgs(argv: string[]) {
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["gateway", "status"],
    booleanFlags: ["--deep", "--json", "--require-rpc", "--no-probe", "--ssh-auto"],
    valueFlags: ["--url", "--token", "--password", "--timeout", "--ssh", "--ssh-identity"],
  });
  if (!values) {
    return null;
  }
  // SSH probe options need the full command because they resolve host aliases and identity files.
  if (
    values.get("--ssh") !== undefined ||
    values.get("--ssh-identity") !== undefined ||
    hasFlag(argv, "--ssh-auto")
  ) {
    return null;
  }
  return {
    rpc: {
      url: values.get("--url"),
      token: values.get("--token"),
      password: values.get("--password"),
      timeout: values.get("--timeout"),
    },
    deep: hasFlag(argv, "--deep"),
    json: hasFlag(argv, "--json"),
    requireRpc: hasFlag(argv, "--require-rpc"),
    probe: !hasFlag(argv, "--no-probe"),
  };
}

/** Parse machine-readable `openclaw gateway health` calls for route-first execution. */
export function parseGatewayHealthRouteArgs(argv: string[]) {
  if (!hasFlag(argv, "--json")) {
    return null;
  }
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["gateway", "health"],
    booleanFlags: ["--expect-final", "--json"],
    valueFlags: ["--url", "--token", "--password", "--timeout", "--port"],
  });
  if (!values) {
    return null;
  }
  const url = values.get("--url");
  const timeout = values.get("--timeout");
  const port = values.get("--port");
  if (timeout !== undefined && parseStrictPositiveInteger(timeout) === undefined) {
    return null;
  }
  let localPortOverride: number | undefined;
  if (port !== undefined) {
    try {
      localPortOverride = parseGatewayPortOption(port);
    } catch {
      return null;
    }
    if (localPortOverride === undefined) {
      return null;
    }
  }
  if (url && localPortOverride !== undefined) {
    return null;
  }
  return {
    rpc: {
      url,
      token: values.get("--token"),
      password: values.get("--password"),
      timeout: timeout ?? "10000",
      expectFinal: hasFlag(argv, "--expect-final"),
      json: true as const,
    },
    localPortOverride,
  };
}

/** Parse `openclaw sessions` filters for JSON/list route execution. */
export function parseSessionsRouteArgs(argv: string[]) {
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["sessions"],
    booleanFlags: ["--json", "--all-agents"],
    valueFlags: ["--agent", "--store", "--active", "--limit"],
  });
  if (!values) {
    return null;
  }
  return {
    json: hasFlag(argv, "--json"),
    allAgents: hasFlag(argv, "--all-agents"),
    agent: values.get("--agent"),
    store: values.get("--store"),
    active: values.get("--active"),
    limit: values.get("--limit"),
  };
}

/** Parse `openclaw agents list` display switches for route-first execution. */
export function parseAgentsListRouteArgs(argv: string[]) {
  const matches = [["agents", "list"], ["agents"]].some(
    (commandPath) =>
      getRoutedCommandPositionals(argv, {
        commandPath,
        booleanFlags: ["--json", "--bindings", "--tree"],
      })?.length === 0,
  );
  return matches
    ? {
        json: hasFlag(argv, "--json"),
        bindings: hasFlag(argv, "--bindings"),
        tree: hasFlag(argv, "--tree"),
      }
    : null;
}

/** Parse `openclaw config get <path>` while preserving root option handling. */
export function parseConfigGetRouteArgs(argv: string[]) {
  const path = parseSinglePositional(argv, {
    commandPath: ["config", "get"],
    booleanFlags: ["--json"],
  });
  if (!path) {
    return null;
  }
  return {
    path,
    json: hasFlag(argv, "--json"),
  };
}

/** Parse `openclaw config unset <path>` and its mutation guard flags. */
export function parseConfigUnsetRouteArgs(argv: string[]) {
  const path = parseSinglePositional(argv, {
    commandPath: ["config", "unset"],
    booleanFlags: ["--dry-run", "--allow-exec", "--json"],
  });
  if (!path) {
    return null;
  }
  return {
    path,
    cliOptions: {
      dryRun: hasFlag(argv, "--dry-run"),
      allowExec: hasFlag(argv, "--allow-exec"),
      json: hasFlag(argv, "--json"),
    },
  };
}

/** Parse `openclaw models list` filters for the lightweight model catalog route. */
export function parseModelsListRouteArgs(argv: string[]) {
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["models", "list"],
    booleanFlags: ["--all", "--local", "--json", "--plain"],
    valueFlags: ["--provider"],
  });
  if (!values) {
    return null;
  }
  return {
    provider: values.get("--provider"),
    all: hasFlag(argv, "--all"),
    local: hasFlag(argv, "--local"),
    json: hasFlag(argv, "--json"),
    plain: hasFlag(argv, "--plain"),
  };
}

function parseModelsRootStatusRouteArgs(argv: string[]) {
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["models"],
    booleanFlags: MODELS_PARENT_BOOLEAN_FLAGS,
    valueFlags: MODELS_PARENT_VALUE_FLAGS,
  });
  if (!values) {
    return null;
  }
  return {
    agent: values.get("--agent"),
    json: hasFlag(argv, "--json") || hasFlag(argv, "--status-json"),
    plain: hasFlag(argv, "--status-plain"),
  };
}

/** Parse both parent aliases and `openclaw models status` through one status owner. */
export function parseModelsStatusRouteArgs(argv: string[]) {
  const rootArgs = parseModelsRootStatusRouteArgs(argv);
  if (rootArgs) {
    return rootArgs;
  }
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["models", "status"],
    booleanFlags: ["--json", "--plain", "--check", "--probe"],
    valueFlags: [
      "--probe-provider",
      "--probe-timeout",
      "--probe-concurrency",
      "--probe-max-tokens",
      "--probe-profile",
      "--agent",
    ],
  });
  if (!values) {
    return null;
  }
  const probeProfileValues = parseRepeatedFlagValues(argv, "--probe-profile");
  if (probeProfileValues === null) {
    return null;
  }
  const probeProfile =
    probeProfileValues.length === 0
      ? undefined
      : probeProfileValues.length === 1
        ? probeProfileValues[0]
        : probeProfileValues;
  return {
    probeProvider: values.get("--probe-provider"),
    probeTimeout: values.get("--probe-timeout"),
    probeConcurrency: values.get("--probe-concurrency"),
    probeMaxTokens: values.get("--probe-max-tokens"),
    agent: values.get("--agent"),
    probeProfile,
    json: hasFlag(argv, "--json"),
    plain: hasFlag(argv, "--plain"),
    check: hasFlag(argv, "--check"),
    probe: hasFlag(argv, "--probe"),
  };
}

/** Parse `openclaw channels list` display flags for the route-first list path. */
export function parseChannelsListRouteArgs(argv: string[]) {
  const positionals = getRoutedCommandPositionals(argv, {
    commandPath: ["channels", "list"],
    booleanFlags: ["--json", "--all"],
  });
  if (!positionals || positionals.length !== 0) {
    return null;
  }
  return {
    json: hasFlag(argv, "--json"),
    all: hasFlag(argv, "--all"),
  };
}

/** Parse `openclaw channels status` probe flags without full CLI registration. */
export function parseChannelsStatusRouteArgs(argv: string[]) {
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["channels", "status"],
    booleanFlags: ["--json", "--probe"],
    valueFlags: ["--timeout", "--channel"],
  });
  if (!values) {
    return null;
  }
  return {
    channel: values.get("--channel"),
    json: hasFlag(argv, "--json"),
    probe: hasFlag(argv, "--probe"),
    timeout: values.get("--timeout"),
  };
}

/** Parse `openclaw plugins list` flags for the metadata-only inventory path. */
export function parsePluginsListRouteArgs(argv: string[]) {
  const positionals = getRoutedCommandPositionals(argv, {
    commandPath: ["plugins", "list"],
    booleanFlags: ["--json", "--enabled", "--verbose"],
  });
  if (!positionals || positionals.length !== 0) {
    return null;
  }
  return {
    json: hasFlag(argv, "--json"),
    enabled: hasFlag(argv, "--enabled"),
    verbose: hasFlag(argv, "--verbose"),
  };
}
