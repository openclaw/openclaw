import type { Command } from "commander";
import type { ProgramContext } from "./context.js";

type CoreCommandRegisterParams = {
  program: Command;
  ctx: ProgramContext;
  argv: string[];
};

type LazyCoreEntry = {
  id: string;
  register: (params: CoreCommandRegisterParams) => Promise<void>;
};

/**
 * Lazy-loadable core command registrations. Each entry dynamically imports only
 * its own command module, avoiding the static import cascade in command-registry.ts
 * that pulls in ~2.8MB of transitive dependencies.
 *
 * Used by run-main.ts when a specific primary command is known, so we skip loading
 * all 11 command groups for a single command invocation.
 */
const lazyCoreEntries: LazyCoreEntry[] = [
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
    id: "doctor",
    register: async ({ program }) => {
      const { registerMaintenanceCommands } = await import("./register.maintenance.js");
      registerMaintenanceCommands(program);
    },
  },
  {
    id: "dashboard",
    register: async ({ program }) => {
      const { registerMaintenanceCommands } = await import("./register.maintenance.js");
      registerMaintenanceCommands(program);
    },
  },
  {
    id: "reset",
    register: async ({ program }) => {
      const { registerMaintenanceCommands } = await import("./register.maintenance.js");
      registerMaintenanceCommands(program);
    },
  },
  {
    id: "uninstall",
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
  },
  {
    id: "agent",
    register: async ({ program, ctx }) => {
      const { registerAgentCommands } = await import("./register.agent.js");
      registerAgentCommands(program, { agentChannelOptions: ctx.agentChannelOptions });
    },
  },
  {
    id: "agents",
    register: async ({ program, ctx }) => {
      const { registerAgentCommands } = await import("./register.agent.js");
      registerAgentCommands(program, { agentChannelOptions: ctx.agentChannelOptions });
    },
  },
  {
    id: "browser",
    register: async ({ program }) => {
      const { registerBrowserCli } = await import("../browser-cli.js");
      registerBrowserCli(program);
    },
  },
  {
    id: "status",
    register: async ({ program }) => {
      const { registerStatusHealthSessionsCommands } =
        await import("./register.status-health-sessions.js");
      registerStatusHealthSessionsCommands(program);
    },
  },
  {
    id: "health",
    register: async ({ program }) => {
      const { registerStatusHealthSessionsCommands } =
        await import("./register.status-health-sessions.js");
      registerStatusHealthSessionsCommands(program);
    },
  },
  {
    id: "sessions",
    register: async ({ program }) => {
      const { registerStatusHealthSessionsCommands } =
        await import("./register.status-health-sessions.js");
      registerStatusHealthSessionsCommands(program);
    },
  },
];

export async function registerCoreCommandByName(
  program: Command,
  ctx: ProgramContext,
  name: string,
  argv: string[],
): Promise<boolean> {
  const entry = lazyCoreEntries.find((e) => e.id === name);
  if (!entry) {
    return false;
  }
  await entry.register({ program, ctx, argv });
  return true;
}

export function getLazyCoreEntries(): readonly LazyCoreEntry[] {
  return lazyCoreEntries;
}
