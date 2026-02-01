import type { Command } from "commander";

import { defaultRuntime } from "../../runtime.js";
import { getFlagValue, getPositiveIntFlagValue, getVerboseFlag, hasFlag } from "../argv.js";
import { runMemoryStatus } from "../memory-cli.js";
import type { ProgramContext } from "./context.js";

type CommandRegisterParams = {
  program: Command;
  ctx: ProgramContext;
  argv: string[];
};

type RouteSpec = {
  match: (path: string[]) => boolean;
  loadPlugins?: boolean;
  run: (argv: string[]) => Promise<boolean>;
};

export type CommandRegistration = {
  id: string;
  register: (params: CommandRegisterParams) => Promise<void> | void;
  routes?: RouteSpec[];
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
    await runMemoryStatus({ agent, json, deep, index, verbose });
    return true;
  },
};

export const commandRegistry: CommandRegistration[] = [
  {
    id: "setup",
    register: async ({ program }) => {
      const { registerSetupCommand } = await import("./register.setup.js");
      registerSetupCommand(program);
    },
  },
  {
    id: "onboard",
    register: async ({ program }) => {
      const { registerOnboardCommand } = await import("./register.onboard.js");
      registerOnboardCommand(program);
    },
  },
  {
    id: "configure",
    register: async ({ program }) => {
      const { registerConfigureCommand } = await import("./register.configure.js");
      registerConfigureCommand(program);
    },
  },
  {
    id: "config",
    register: async ({ program }) => {
      const { registerConfigCli } = await import("../config-cli.js");
      registerConfigCli(program);
    },
  },
  {
    id: "git",
    register: async ({ program }) => {
      const { registerGitCommand } = await import("./register.git.js");
      registerGitCommand(program);
    },
  },
  {
    id: "maintenance",
    register: async ({ program }) => {
      const { registerMaintenanceCommands } = await import("./register.maintenance.js");
      registerMaintenanceCommands(program);
    },
  },
  {
    id: "message",
    register: async ({ program, ctx }) => {
      const { registerMessageCommands } = await import("./register.message.js");
      registerMessageCommands(program, ctx);
    },
  },
  {
    id: "memory",
    register: async ({ program }) => {
      const { registerMemoryCli } = await import("../memory-cli.js");
      registerMemoryCli(program);
    },
    routes: [routeMemoryStatus],
  },
  {
    id: "agent",
    register: async ({ program, ctx }) => {
      const { registerAgentCommands } = await import("./register.agent.js");
      registerAgentCommands(program, { agentChannelOptions: ctx.agentChannelOptions });
    },
    routes: [routeAgentsList],
  },
  {
    id: "subclis",
    register: async ({ program, argv }) => {
      const { registerSubCliCommands } = await import("./register.subclis.js");
      registerSubCliCommands(program, argv);
    },
  },
  {
    id: "status-health-sessions",
    register: async ({ program }) => {
      const { registerStatusHealthSessionsCommands } =
        await import("./register.status-health-sessions.js");
      registerStatusHealthSessionsCommands(program);
    },
    routes: [routeHealth, routeStatus, routeSessions],
  },
  {
    id: "browser",
    register: async ({ program }) => {
      const { registerBrowserCli } = await import("../browser-cli.js");
      registerBrowserCli(program);
    },
  },
];

export async function registerProgramCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[] = process.argv,
) {
  for (const entry of commandRegistry) {
    await entry.register({ program, ctx, argv });
  }
}

export function findRoutedCommand(path: string[]): RouteSpec | null {
  for (const entry of commandRegistry) {
    if (!entry.routes) {
      continue;
    }
    for (const route of entry.routes) {
      if (route.match(path)) {
        return route;
      }
    }
  }
  return null;
}
