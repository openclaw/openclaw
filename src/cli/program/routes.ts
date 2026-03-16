import { isValueToken } from "../../infra/cli-root-options.js";
import { defaultRuntime } from "../../runtime.js";
import {
  getCommandPositionalsWithRootOptions,
  getFlagValue,
  getPositiveIntFlagValue,
  getVerboseFlag,
  hasFlag,
} from "../argv.js";

export type RouteSpec = {
  match: (path: string[]) => boolean;
  loadPlugins?: boolean | ((argv: string[]) => boolean);
  run: (argv: string[]) => Promise<boolean>;
};

const routeHealth: RouteSpec = {
  match: (path) => path[0] === "health",
  // `health --json` only relays gateway RPC output and does not need local plugin metadata.
  // Keep plugin preload for text output where channel diagnostics/logSelfId are rendered.
  loadPlugins: (argv) => !hasFlag(argv, "--json"),
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
    if (timeoutMs === null) {
      return false;
    }
    const { healthCommand } = await import("../../commands/health.js");
    await healthCommand({ json, timeoutMs, verbose }, defaultRuntime);
    return true;
  },
};

const routeStatus: RouteSpec = {
  match: (path) => path[0] === "status",
  // `status --json` can defer channel plugin loading until config/env inspection
  // proves it is needed, which keeps the fast-path startup lightweight.
  loadPlugins: (argv) => !hasFlag(argv, "--json"),
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const deep = hasFlag(argv, "--deep");
    const all = hasFlag(argv, "--all");
    const usage = hasFlag(argv, "--usage");
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
    if (timeoutMs === null) {
      return false;
    }
    if (json) {
      const { statusJsonCommand } = await import("../../commands/status-json.js");
      await statusJsonCommand({ deep, all, usage, timeoutMs }, defaultRuntime);
      return true;
    }
    const { statusCommand } = await import("../../commands/status.js");
    await statusCommand({ json, deep, all, usage, timeoutMs, verbose }, defaultRuntime);
    return true;
  },
};

const routeGatewayStatus: RouteSpec = {
  match: (path) => path[0] === "gateway" && path[1] === "status",
  run: async (argv) => {
    const url = getFlagValue(argv, "--url");
    if (url === null) {
      return false;
    }
    const token = getFlagValue(argv, "--token");
    if (token === null) {
      return false;
    }
    const password = getFlagValue(argv, "--password");
    if (password === null) {
      return false;
    }
    const timeout = getFlagValue(argv, "--timeout");
    if (timeout === null) {
      return false;
    }
    const ssh = getFlagValue(argv, "--ssh");
    if (ssh === null) {
      return false;
    }
    if (ssh !== undefined) {
      return false;
    }
    const sshIdentity = getFlagValue(argv, "--ssh-identity");
    if (sshIdentity === null) {
      return false;
    }
    if (sshIdentity !== undefined) {
      return false;
    }
    if (hasFlag(argv, "--ssh-auto")) {
      return false;
    }
    const deep = hasFlag(argv, "--deep");
    const json = hasFlag(argv, "--json");
    const requireRpc = hasFlag(argv, "--require-rpc");
    const probe = !hasFlag(argv, "--no-probe");
    const { runDaemonStatus } = await import("../daemon-cli/status.js");
    await runDaemonStatus({
      rpc: {
        url: url ?? undefined,
        token: token ?? undefined,
        password: password ?? undefined,
        timeout: timeout ?? undefined,
      },
      probe,
      requireRpc,
      deep,
      json,
    });
    return true;
  },
};

const routeSessions: RouteSpec = {
  // Fast-path only bare `sessions`; subcommands (e.g. `sessions cleanup`)
  // must fall through to Commander so nested handlers run.
  match: (path) => path[0] === "sessions" && !path[1],
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const allAgents = hasFlag(argv, "--all-agents");
    const agent = getFlagValue(argv, "--agent");
    if (agent === null) {
      return false;
    }
    const store = getFlagValue(argv, "--store");
    if (store === null) {
      return false;
    }
    const active = getFlagValue(argv, "--active");
    if (active === null) {
      return false;
    }
    const { sessionsCommand } = await import("../../commands/sessions.js");
    await sessionsCommand({ json, store, agent, allAgents, active }, defaultRuntime);
    return true;
  },
};

const routeAgentsList: RouteSpec = {
  match: (path) => path[0] === "agents" && path[1] === "list",
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const bindings = hasFlag(argv, "--bindings");
    const { agentsListCommand } = await import("../../commands/agents.js");
    await agentsListCommand({ json, bindings }, defaultRuntime);
    return true;
  },
};

const routeMemoryStatus: RouteSpec = {
  match: (path) => path[0] === "memory" && path[1] === "status",
  run: async (argv) => {
    const agent = getFlagValue(argv, "--agent");
    if (agent === null) {
      return false;
    }
    const json = hasFlag(argv, "--json");
    const deep = hasFlag(argv, "--deep");
    const index = hasFlag(argv, "--index");
    const verbose = hasFlag(argv, "--verbose");
    const { runMemoryStatus } = await import("../memory-cli.js");
    await runMemoryStatus({ agent, json, deep, index, verbose });
    return true;
  },
};

function getFlagValues(argv: string[], name: string): string[] | null {
  const values: string[] = [];
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === "--") {
      break;
    }
    if (arg === name) {
      const next = args[i + 1];
      if (!isValueToken(next)) {
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

const routeConfigGet: RouteSpec = {
  match: (path) => path[0] === "config" && path[1] === "get",
  run: async (argv) => {
    const positionals = getCommandPositionalsWithRootOptions(argv, {
      commandPath: ["config", "get"],
      booleanFlags: ["--json"],
    });
    if (!positionals || positionals.length !== 1) {
      return false;
    }
    const pathArg = positionals[0];
    if (!pathArg) {
      return false;
    }
    const json = hasFlag(argv, "--json");
    const { runConfigGet } = await import("../config-cli.js");
    await runConfigGet({ path: pathArg, json });
    return true;
  },
};

const routeConfigUnset: RouteSpec = {
  match: (path) => path[0] === "config" && path[1] === "unset",
  run: async (argv) => {
    const positionals = getCommandPositionalsWithRootOptions(argv, {
      commandPath: ["config", "unset"],
    });
    if (!positionals || positionals.length !== 1) {
      return false;
    }
    const pathArg = positionals[0];
    if (!pathArg) {
      return false;
    }
    const { runConfigUnset } = await import("../config-cli.js");
    await runConfigUnset({ path: pathArg });
    return true;
  },
};

const routeModelsList: RouteSpec = {
  match: (path) => path[0] === "models" && path[1] === "list",
  run: async (argv) => {
    const provider = getFlagValue(argv, "--provider");
    if (provider === null) {
      return false;
    }
    const all = hasFlag(argv, "--all");
    const local = hasFlag(argv, "--local");
    const json = hasFlag(argv, "--json");
    const plain = hasFlag(argv, "--plain");
    const { modelsListCommand } = await import("../../commands/models.js");
    await modelsListCommand({ all, local, provider, json, plain }, defaultRuntime);
    return true;
  },
};

const routeModelsStatus: RouteSpec = {
  match: (path) => path[0] === "models" && path[1] === "status",
  run: async (argv) => {
    const probeProvider = getFlagValue(argv, "--probe-provider");
    if (probeProvider === null) {
      return false;
    }
    const probeTimeout = getFlagValue(argv, "--probe-timeout");
    if (probeTimeout === null) {
      return false;
    }
    const probeConcurrency = getFlagValue(argv, "--probe-concurrency");
    if (probeConcurrency === null) {
      return false;
    }
    const probeMaxTokens = getFlagValue(argv, "--probe-max-tokens");
    if (probeMaxTokens === null) {
      return false;
    }
    const agent = getFlagValue(argv, "--agent");
    if (agent === null) {
      return false;
    }
    const probeProfileValues = getFlagValues(argv, "--probe-profile");
    if (probeProfileValues === null) {
      return false;
    }
    const probeProfile =
      probeProfileValues.length === 0
        ? undefined
        : probeProfileValues.length === 1
          ? probeProfileValues[0]
          : probeProfileValues;
    const json = hasFlag(argv, "--json");
    const plain = hasFlag(argv, "--plain");
    const check = hasFlag(argv, "--check");
    const probe = hasFlag(argv, "--probe");
    const { modelsStatusCommand } = await import("../../commands/models.js");
    await modelsStatusCommand(
      {
        json,
        plain,
        check,
        probe,
        probeProvider,
        probeProfile,
        probeTimeout,
        probeConcurrency,
        probeMaxTokens,
        agent,
      },
      defaultRuntime,
    );
    return true;
  },
};

const routes: RouteSpec[] = [
  routeHealth,
  routeStatus,
  routeGatewayStatus,
  routeSessions,
  routeAgentsList,
  routeMemoryStatus,
  routeConfigGet,
  routeConfigUnset,
  routeModelsList,
  routeModelsStatus,
];

export function findRoutedCommand(path: string[]): RouteSpec | null {
  for (const route of routes) {
    if (route.match(path)) {
      return route;
    }
  }
  return null;
}
