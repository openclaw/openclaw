import { defaultRuntime } from "../../runtime.js";
import { getFlagValue, getPositiveIntFlagValue, getVerboseFlag, hasFlag } from "../argv.js";

export type RouteSpec = {
  match: (path: string[]) => boolean;
  loadPlugins?: boolean;
  run: (argv: string[]) => Promise<boolean>;
};

const routeHealth: RouteSpec = {
  match: (path) => path[0] === "health",
  loadPlugins: true,
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
  loadPlugins: true,
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
    const { statusCommand } = await import("../../commands/status.js");
    await statusCommand({ json, deep, all, usage, timeoutMs, verbose }, defaultRuntime);
    return true;
  },
};

const routeSessions: RouteSpec = {
  match: (path) => path[0] === "sessions",
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const store = getFlagValue(argv, "--store");
    if (store === null) {
      return false;
    }
    const active = getFlagValue(argv, "--active");
    if (active === null) {
      return false;
    }
    const { sessionsCommand } = await import("../../commands/sessions.js");
    await sessionsCommand({ json, store, active }, defaultRuntime);
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

function getCommandPositionals(argv: string[]): string[] {
  const out: string[] = [];
  const args = argv.slice(2);
  for (const arg of args) {
    if (!arg || arg === "--") {
      break;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

const routeConfigGet: RouteSpec = {
  match: (path) => path[0] === "config" && path[1] === "get",
  run: async (argv) => {
    const positionals = getCommandPositionals(argv);
    const pathArg = positionals[2];
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
    const positionals = getCommandPositionals(argv);
    const pathArg = positionals[2];
    if (!pathArg) {
      return false;
    }
    const { runConfigUnset } = await import("../config-cli.js");
    await runConfigUnset({ path: pathArg });
    return true;
  },
};

const routes: RouteSpec[] = [
  routeHealth,
  routeStatus,
  routeSessions,
  routeAgentsList,
  routeMemoryStatus,
  routeConfigGet,
  routeConfigUnset,
];

export function findRoutedCommand(path: string[]): RouteSpec | null {
  for (const route of routes) {
    if (route.match(path)) {
      return route;
    }
  }
  return null;
}
