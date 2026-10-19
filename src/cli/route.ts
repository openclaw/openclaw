import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import { FLAG_TERMINATOR, isValueToken } from "../infra/cli-root-options.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { type LogLevel, tryParseLogLevel } from "../logging/levels.js";
import { defaultRuntime } from "../runtime.js";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import {
  getCommandPositionalsWithRootOptions,
  getFlagValue,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
} from "./argv.js";
import { cliCommandCatalog } from "./command-catalog.js";
import {
  applyCliExecutionStartupPresentation,
  ensureCliExecutionBootstrap,
} from "./command-execution-startup.js";
import { matchesCommandPath } from "./command-path-matches.js";
import { resolveCliStartupPolicy } from "./command-startup-policy.js";
import { parseGatewayPortOption } from "./gateway-port-option.js";
import { MODELS_PARENT_BOOLEAN_FLAGS, MODELS_PARENT_VALUE_FLAGS } from "./parent-command-path.js";

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
function parseHealthRouteArgs(argv: string[]) {
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
    verbose: getVerboseFlag(argv),
    timeoutMs,
  };
}

/** Parse `openclaw status` flags without registering the full command tree. */
function parseStatusRouteArgs(argv: string[]) {
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
    verbose: getVerboseFlag(argv),
    timeoutMs,
  };
}

/** Parse `openclaw gateway status` RPC-only flags accepted by the fast route. */
function parseGatewayStatusRouteArgs(argv: string[]) {
  const values = parseRoutedValueFlags(argv, {
    commandPath: ["gateway", "status"],
    booleanFlags: [
      "--deep",
      "--json",
      "--require-rpc",
      "--no-probe",
      "--ssh-auto",
      "--runtime-intent-only",
    ],
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
    ...(hasFlag(argv, "--runtime-intent-only") ? { runtimeIntentOnly: true } : {}),
  };
}

/** Parse machine-readable `openclaw gateway health` calls for route-first execution. */
function parseGatewayHealthRouteArgs(argv: string[]) {
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
function parseSessionsRouteArgs(argv: string[]) {
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
function parseAgentsListRouteArgs(argv: string[]) {
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
function parseConfigGetRouteArgs(argv: string[]) {
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
function parseConfigUnsetRouteArgs(argv: string[]) {
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
function parseModelsListRouteArgs(argv: string[]) {
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

/** Parse both parent aliases and `openclaw models status` through one status owner. */
function parseModelsStatusRouteArgs(argv: string[]) {
  const rootValues = parseRoutedValueFlags(argv, {
    commandPath: ["models"],
    booleanFlags: MODELS_PARENT_BOOLEAN_FLAGS,
    valueFlags: MODELS_PARENT_VALUE_FLAGS,
  });
  if (rootValues) {
    return {
      agent: rootValues.get("--agent"),
      json: hasFlag(argv, "--json") || hasFlag(argv, "--status-json"),
      plain: hasFlag(argv, "--status-plain"),
    };
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
function parseChannelsListRouteArgs(argv: string[]) {
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
function parseChannelsStatusRouteArgs(argv: string[]) {
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
function parsePluginsListRouteArgs(argv: string[]) {
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

function defineRoutedCommand<TArgs>(
  parseArgs: (argv: string[]) => TArgs | null,
  runParsedArgs: (args: TArgs) => Promise<void>,
) {
  return (argv: string[]) => {
    const args = parseArgs(argv);
    return args === null ? null : () => runParsedArgs(args);
  };
}

const routedCommandDefinitions = {
  health: defineRoutedCommand(parseHealthRouteArgs, async (args) => {
    const { healthCommand } = await import("../commands/health.js");
    await healthCommand(args, defaultRuntime);
  }),
  status: defineRoutedCommand(parseStatusRouteArgs, async (args) => {
    if (args.json) {
      const { statusJsonCommand } = await import("../commands/status-json.js");
      await statusJsonCommand(
        {
          deep: args.deep,
          all: args.all,
          usage: args.usage,
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          timeoutMs: args.timeoutMs,
        },
        defaultRuntime,
      );
      return;
    }
    const { statusCommand } = await import("../commands/status.js");
    await statusCommand(args, defaultRuntime);
  }),
  "gateway-status": defineRoutedCommand(parseGatewayStatusRouteArgs, async (args) => {
    const { runDaemonStatus } = await import("./daemon-cli/status.js");
    await runDaemonStatus(args);
  }),
  "gateway-health": defineRoutedCommand(parseGatewayHealthRouteArgs, async (args) => {
    const { runGatewayHealthJsonRoute } = await import("./gateway-cli/health-route.js");
    await runGatewayHealthJsonRoute(args, defaultRuntime);
  }),
  sessions: defineRoutedCommand(parseSessionsRouteArgs, async (args) => {
    const { sessionsCommand } = await import("../commands/sessions.js");
    await sessionsCommand(args, defaultRuntime);
  }),
  "agents-list": defineRoutedCommand(parseAgentsListRouteArgs, async (args) => {
    const { agentsListCommand } = await import("../commands/agents.commands.list.js");
    await agentsListCommand(args, defaultRuntime);
  }),
  "config-get": defineRoutedCommand(parseConfigGetRouteArgs, async (args) => {
    const { runConfigGet } = await import("./config-cli.js");
    await runConfigGet(args);
  }),
  "config-unset": defineRoutedCommand(parseConfigUnsetRouteArgs, async (args) => {
    const { runConfigUnset } = await import("./config-cli.js");
    await runConfigUnset({
      ...args,
      localStateOwner: { method: "config unset", target: args.path },
    });
  }),
  "models-list": defineRoutedCommand(parseModelsListRouteArgs, async (args) => {
    const { modelsListCommand } = await import("../commands/models/list.list-command.js");
    await modelsListCommand(args, defaultRuntime);
  }),
  "models-status": defineRoutedCommand(parseModelsStatusRouteArgs, async (args) => {
    const { modelsStatusCommand } = await import("../commands/models/list.status-command.js");
    await modelsStatusCommand(args, defaultRuntime);
  }),
  "channels-list": defineRoutedCommand(parseChannelsListRouteArgs, async (args) => {
    const { channelsListCommand } = await import("../commands/channels/list.js");
    await channelsListCommand(args, defaultRuntime);
  }),
  "channels-status": defineRoutedCommand(parseChannelsStatusRouteArgs, async (args) => {
    const { channelsStatusCommand } = await import("../commands/channels/status.js");
    await channelsStatusCommand(args, defaultRuntime);
  }),
  "plugins-list": defineRoutedCommand(parsePluginsListRouteArgs, async (args) => {
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    await runPluginsListCommand(args, defaultRuntime);
  }),
};

/** Bind validated arguments before startup; defer command imports and execution until afterward. */
function findRoutedCommand(path: string[], argv: string[]): (() => Promise<void>) | null {
  for (const entry of cliCommandCatalog) {
    if (!entry.route || !matchesCommandPath(path, entry.commandPath, { exact: entry.exact })) {
      continue;
    }
    const run = routedCommandDefinitions[entry.route.id](argv);
    if (run) {
      return run;
    }
  }
  return null;
}

const LOG_LEVEL_FLAG = "--log-level";
const LOG_LEVEL_EQUALS_PREFIX = `${LOG_LEVEL_FLAG}=`;

function resolveRoutedCliLogLevel(argv: string[]): LogLevel | null | undefined {
  const args = argv.slice(2);
  let logLevel: LogLevel | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    let value: string | undefined;
    if (arg === LOG_LEVEL_FLAG) {
      value = args[++index];
      if (!isValueToken(value)) {
        return null;
      }
    } else if (arg.startsWith(LOG_LEVEL_EQUALS_PREFIX)) {
      value = arg.slice(LOG_LEVEL_EQUALS_PREFIX.length);
    } else {
      continue;
    }
    const parsed = tryParseLogLevel(value);
    if (!parsed) {
      return null;
    }
    logLevel = parsed;
  }

  return logLevel;
}

export async function tryRouteCli(
  argv: string[],
  options: { machineOutput?: boolean } = {},
): Promise<boolean> {
  if (isTruthyEnvValue(process.env.OPENCLAW_DISABLE_ROUTE_FIRST)) {
    return false;
  }
  const invocation = resolveCliArgvInvocation(argv);
  if (invocation.hasHelpOrVersion) {
    return false;
  }
  if (!invocation.commandPath[0]) {
    return false;
  }
  const run = findRoutedCommand(invocation.commandPath, argv);
  if (!run) {
    return false;
  }
  const logLevel = resolveRoutedCliLogLevel(argv);
  if (logLevel === null) {
    // Let Commander own the existing user-facing --log-level validation errors.
    return false;
  }
  if (logLevel) {
    process.env.OPENCLAW_LOG_LEVEL = logLevel;
  }
  const startupPolicy = resolveCliStartupPolicy({
    argv,
    commandPath: invocation.commandPath,
    jsonOutputMode: options.machineOutput === true || hasFlag(argv, "--json"),
  });
  const { VERSION } = await import("../version.js");
  await applyCliExecutionStartupPresentation({
    argv,
    startupPolicy,
    showBanner: process.stdout.isTTY && !startupPolicy.suppressDoctorStdout,
    version: VERSION,
  });
  await ensureCliExecutionBootstrap({
    runtime: defaultRuntime,
    commandPath: invocation.commandPath,
    startupPolicy,
  });
  await run();
  return true;
}
