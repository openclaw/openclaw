import type { Command } from "commander";
import type { ProgramContext } from "./context.js";
import { registerBrowserCli } from "../browser-cli.js";
import { registerConfigCli } from "../config-cli.js";
import { registerMemoryCli } from "../memory-cli.js";
import { registerAgentCommands } from "./register.agent.js";
import { registerConfigureCommand } from "./register.configure.js";
import { registerMaintenanceCommands } from "./register.maintenance.js";
import { registerMessageCommands } from "./register.message.js";
import { registerOnboardCommand } from "./register.onboard.js";
import { registerSetupCommand } from "./register.setup.js";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";
import { registerSubCliCommands } from "./register.subclis.js";

type CommandRegisterParams = {
  program: Command;
  ctx: ProgramContext;
  argv: string[];
};

type CommandRegistration = {
  id: string;
  register: (params: CommandRegisterParams) => void;
};

const commandRegistry: CommandRegistration[] = [
  {
    id: "setup",
    register: ({ program }) => registerSetupCommand(program),
  },
  {
    id: "onboard",
    register: ({ program }) => registerOnboardCommand(program),
  },
  {
    id: "configure",
    register: ({ program }) => registerConfigureCommand(program),
  },
  {
    id: "config",
    register: ({ program }) => registerConfigCli(program),
  },
  {
    id: "maintenance",
    register: ({ program }) => registerMaintenanceCommands(program),
  },
  {
    id: "message",
    register: ({ program, ctx }) => registerMessageCommands(program, ctx),
  },
  {
    id: "memory",
    register: ({ program }) => registerMemoryCli(program),
  },
  {
    id: "agent",
    register: ({ program, ctx }) =>
      registerAgentCommands(program, { agentChannelOptions: ctx.agentChannelOptions }),
  },
  {
    id: "subclis",
    register: ({ program, argv }) => registerSubCliCommands(program, argv),
  },
  {
    id: "status-health-sessions",
    register: ({ program }) => registerStatusHealthSessionsCommands(program),
  },
  {
    id: "browser",
    register: ({ program }) => registerBrowserCli(program),
  },
];

export function registerProgramCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[] = process.argv,
) {
  for (const entry of commandRegistry) {
    entry.register({ program, ctx, argv });
  }
}
