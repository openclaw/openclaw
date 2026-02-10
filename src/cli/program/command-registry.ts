import type { Command } from "commander";
import type { ProgramContext } from "./context.js";
import { getFlagValue, getPositiveIntFlagValue, getVerboseFlag, hasFlag } from "../argv.js";

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
  register: (params: CommandRegisterParams) => void | Promise<void>;
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
    const { defaultRuntime } = await import("../../runtime.js");
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
    const { defaultRuntime } = await import("../../runtime.js");
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
    const { defaultRuntime } = await import("../../runtime.js");
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
    const { defaultRuntime } = await import("../../runtime.js");
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
      await registerMessageCommands(program, ctx);
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
      await registerSubCliCommands(program, argv);
    },
  },
  {
    id: "status-health-sessions",
    register: async ({ program }) => {
      const { registerStatusHealthSessionsCommands } = await import(
        "./register.status-health-sessions.js"
      );
      registerStatusHealthSessionsCommands(program);
    },
    routes: [routeHealth, routeStatus, routeSessions],
  },
  {
    id: "browser",
    register: async ({ program }) => {
      const { registerBrowserCli } = await import("../browser-cli.js");
      await registerBrowserCli(program);
    },
  },
];

export async function registerProgramCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[] = process.argv,
  opts?: { helpOnly?: boolean },
) {
  const helpOnly = opts?.helpOnly ?? false;

  const entries = helpOnly
    ? commandRegistry.map((entry) => {
        // For bare --help, stub heavy registrations (message/browser load 20+
        // sub-modules and take ~2s). The top-level command name & description
        // is all Commander needs for the help listing.
        if (entry.id === "message") {
          return {
            ...entry,
            register: async ({ program: p }: CommandRegisterParams) => {
              p.command("message").description("Send messages and channel actions");
            },
          };
        }
        if (entry.id === "browser") {
          return {
            ...entry,
            register: async ({ program: p }: CommandRegisterParams) => {
              p.command("browser").description(
                "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
              );
            },
          };
        }
        return entry;
      })
    : commandRegistry;

  await Promise.all(entries.map((entry) => entry.register({ program, ctx, argv })));
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
