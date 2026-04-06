import { defaultRuntime } from "../../runtime.js";
import { hasFlag } from "../argv.js";
import { shouldLoadPluginsForCommandPath } from "../command-startup-policy.js";
import {
  parseAgentsListRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
} from "./route-args.js";

export type RouteSpec = {
  match: (path: string[]) => boolean;
  loadPlugins?: boolean | ((argv: string[]) => boolean);
  run: (argv: string[]) => Promise<boolean>;
};

const routeHealth: RouteSpec = {
  match: (path) => path[0] === "health",
  // `health --json` only relays gateway RPC output and does not need local plugin metadata.
  // Keep plugin preload for text output where channel diagnostics/logSelfId are rendered.
  loadPlugins: (argv) =>
    shouldLoadPluginsForCommandPath({
      commandPath: ["health"],
      jsonOutputMode: hasFlag(argv, "--json"),
    }),
  run: async (argv) => {
    const args = parseHealthRouteArgs(argv);
    if (!args) {
      return false;
    }
    const { healthCommand } = await import("../../commands/health.js");
    await healthCommand(args, defaultRuntime);
    return true;
  },
};

const routeStatus: RouteSpec = {
  match: (path) => path[0] === "status",
  // `status --json` can defer channel plugin loading until config/env inspection
  // proves it is needed, which keeps the fast-path startup lightweight.
  loadPlugins: (argv) =>
    shouldLoadPluginsForCommandPath({
      commandPath: ["status"],
      jsonOutputMode: hasFlag(argv, "--json"),
    }),
  run: async (argv) => {
    const args = parseStatusRouteArgs(argv);
    if (!args) {
      return false;
    }
    if (args.json) {
      const { statusJsonCommand } = await import("../../commands/status-json.js");
      await statusJsonCommand(
        {
          deep: args.deep,
          all: args.all,
          usage: args.usage,
          timeoutMs: args.timeoutMs,
        },
        defaultRuntime,
      );
      return true;
    }
    const { statusCommand } = await import("../../commands/status.js");
    await statusCommand(args, defaultRuntime);
    return true;
  },
};

const routeGatewayStatus: RouteSpec = {
  match: (path) => path[0] === "gateway" && path[1] === "status",
  run: async (argv) => {
    const args = parseGatewayStatusRouteArgs(argv);
    if (!args) {
      return false;
    }
    const { runDaemonStatus } = await import("../daemon-cli/status.js");
    await runDaemonStatus(args);
    return true;
  },
};

const routeSessions: RouteSpec = {
  // Fast-path only bare `sessions`; subcommands (e.g. `sessions cleanup`)
  // must fall through to Commander so nested handlers run.
  match: (path) => path[0] === "sessions" && !path[1],
  run: async (argv) => {
    const args = parseSessionsRouteArgs(argv);
    if (!args) {
      return false;
    }
    const { sessionsCommand } = await import("../../commands/sessions.js");
    await sessionsCommand(args, defaultRuntime);
    return true;
  },
};

const routeAgentsList: RouteSpec = {
  match: (path) => path[0] === "agents" && path[1] === "list",
  run: async (argv) => {
    const { agentsListCommand } = await import("../../commands/agents.js");
    await agentsListCommand(parseAgentsListRouteArgs(argv), defaultRuntime);
    return true;
  },
};

const routeConfigGet: RouteSpec = {
  match: (path) => path[0] === "config" && path[1] === "get",
  run: async (argv) => {
    const args = parseConfigGetRouteArgs(argv);
    if (!args) {
      return false;
    }
    const { runConfigGet } = await import("../config-cli.js");
    await runConfigGet(args);
    return true;
  },
};

const routeConfigUnset: RouteSpec = {
  match: (path) => path[0] === "config" && path[1] === "unset",
  run: async (argv) => {
    const args = parseConfigUnsetRouteArgs(argv);
    if (!args) {
      return false;
    }
    const { runConfigUnset } = await import("../config-cli.js");
    await runConfigUnset(args);
    return true;
  },
};

const routeModelsList: RouteSpec = {
  match: (path) => path[0] === "models" && path[1] === "list",
  run: async (argv) => {
    const args = parseModelsListRouteArgs(argv);
    if (!args) {
      return false;
    }
    const { modelsListCommand } = await import("../../commands/models.js");
    await modelsListCommand(args, defaultRuntime);
    return true;
  },
};

const routeModelsStatus: RouteSpec = {
  match: (path) => path[0] === "models" && path[1] === "status",
  run: async (argv) => {
    const args = parseModelsStatusRouteArgs(argv);
    if (!args) {
      return false;
    }
    const { modelsStatusCommand } = await import("../../commands/models.js");
    await modelsStatusCommand(args, defaultRuntime);
    return true;
  },
};

const routes: RouteSpec[] = [
  routeHealth,
  routeStatus,
  routeGatewayStatus,
  routeSessions,
  routeAgentsList,
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
