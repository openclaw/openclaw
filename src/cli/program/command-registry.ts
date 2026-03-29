import type { Command } from "commander";
import { getPrimaryCommand, hasHelpOrVersion } from "../argv.js";
import { reparseProgramFromActionArgs } from "./action-reparse.js";
import { removeCommandByName } from "./command-tree.js";
import type { ProgramContext } from "./context.js";
import {
  type CoreCliCommandDescriptor,
  getCoreCliCommandDescriptors,
  getCoreCliCommandsWithSubcommands,
} from "./core-command-descriptors.js";
import { registerSubCliCommands } from "./register.subclis.js";

export { getCoreCliCommandDescriptors, getCoreCliCommandsWithSubcommands };

type CommandRegisterParams = {
  program: Command;
  ctx: ProgramContext;
  argv: string[];
};

export type CommandRegistration = {
  id: string;
  register: (params: CommandRegisterParams) => void;
};

type CoreCliEntry = {
  commands: CoreCliCommandDescriptor[];
  register: (params: CommandRegisterParams) => Promise<void> | void;
};

const shouldRegisterCorePrimaryOnly = (argv: string[]) => {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  return true;
};

// Note for humans and agents:
// If you update the list of commands, also check whether they have subcommands
// and set the flag accordingly.
const coreEntries: CoreCliEntry[] = [
  {
    commands: [
      {
        name: "setup",
        description: "Initialize local config and agent workspace",
        hasSubcommands: false,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("./register.setup.js");
      mod.registerSetupCommand(program);
    },
  },
  {
    commands: [
      {
        name: "onboard",
        description: "Interactive onboarding for gateway, workspace, and skills",
        hasSubcommands: false,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("./register.onboard.js");
      mod.registerOnboardCommand(program);
    },
  },
  {
    commands: [
      {
        name: "configure",
        description:
          "Interactive configuration for credentials, channels, gateway, and agent defaults",
        hasSubcommands: false,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("./register.configure.js");
      mod.registerConfigureCommand(program);
    },
  },
  {
    commands: [
      {
        name: "config",
        description:
          "Non-interactive config helpers (get/set/unset/file/validate). Default: starts guided setup.",
        hasSubcommands: true,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("../config-cli.js");
      mod.registerConfigCli(program);
    },
  },
  {
    commands: [
      {
        name: "backup",
        description: "Create and verify local backup archives for OpenClaw state",
        hasSubcommands: true,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("./register.backup.js");
      mod.registerBackupCommand(program);
    },
  },
  {
    commands: [
      {
        name: "doctor",
        description: "Health checks + quick fixes for the gateway and channels",
        hasSubcommands: false,
      },
      {
        name: "dashboard",
        description: "Open the Control UI with your current token",
        hasSubcommands: false,
      },
      {
        name: "reset",
        description: "Reset local config/state (keeps the CLI installed)",
        hasSubcommands: false,
      },
      {
        name: "uninstall",
        description: "Uninstall the gateway service + local data (CLI remains)",
        hasSubcommands: false,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("./register.maintenance.js");
      mod.registerMaintenanceCommands(program);
    },
  },
  {
    commands: [
      {
        name: "message",
        description: "Send, read, and manage messages",
        hasSubcommands: true,
      },
    ],
    register: async ({ program, ctx }) => {
      const mod = await import("./register.message.js");
      mod.registerMessageCommands(program, ctx);
    },
  },
  {
    commands: [
      {
        name: "mcp",
        description: "Manage OpenClaw MCP config and channel bridge",
        hasSubcommands: true,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("../mcp-cli.js");
      mod.registerMcpCli(program);
    },
  },
  {
    commands: [
      {
        name: "agent",
        description: "Run one agent turn via the Gateway",
        hasSubcommands: false,
      },
      {
        name: "agents",
        description: "Manage isolated agents (workspaces, auth, routing)",
        hasSubcommands: true,
      },
    ],
    register: async ({ program, ctx }) => {
      const mod = await import("./register.agent.js");
      mod.registerAgentCommands(program, {
        agentChannelOptions: ctx.agentChannelOptions,
      });
    },
  },
  {
    commands: [
      {
        name: "status",
        description: "Show channel health and recent session recipients",
        hasSubcommands: false,
      },
      {
        name: "health",
        description: "Fetch health from the running gateway",
        hasSubcommands: false,
      },
      {
        name: "sessions",
        description: "List stored conversation sessions",
        hasSubcommands: true,
      },
      {
        name: "tasks",
        description: "Inspect durable background task state",
        hasSubcommands: true,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("./register.status-health-sessions.js");
      mod.registerStatusHealthSessionsCommands(program);
    },
  },
  {
    commands: [
      {
        name: "arbitrage",
        description: "Manage Aave flashloan arbitrage bot",
        hasSubcommands: true,
      },
    ],
    register: async ({ program }) => {
      const mod = await import("../../commands/arbitrage.js");
      program.addCommand(mod.createArbitrageCommand());
    },
  },
];

export function getCoreCliCommandNames(): string[] {
  return getCoreCliCommandDescriptors().map((command) => command.name);
}

function removeEntryCommands(program: Command, entry: CoreCliEntry) {
  // Some registrars install multiple top-level commands (e.g. status/health/sessions).
  // Remove placeholders/old registrations for all names in the entry before re-registering.
  for (const cmd of entry.commands) {
    removeCommandByName(program, cmd.name);
  }
}

function registerLazyCoreCommand(
  program: Command,
  ctx: ProgramContext,
  entry: CoreCliEntry,
  command: CoreCliCommandDescriptor,
) {
  const placeholder = program.command(command.name).description(command.description);
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    removeEntryCommands(program, entry);
    await entry.register({ program, ctx, argv: process.argv });
    await reparseProgramFromActionArgs(program, actionArgs);
  });
}

export async function registerCoreCliByName(
  program: Command,
  ctx: ProgramContext,
  name: string,
  argv: string[] = process.argv,
): Promise<boolean> {
  const entry = coreEntries.find((candidate) =>
    candidate.commands.some((cmd) => cmd.name === name),
  );
  if (!entry) {
    return false;
  }

  removeEntryCommands(program, entry);
  await entry.register({ program, ctx, argv });
  return true;
}

export function registerCoreCliCommands(program: Command, ctx: ProgramContext, argv: string[]) {
  const primary = getPrimaryCommand(argv);
  if (primary && shouldRegisterCorePrimaryOnly(argv)) {
    const entry = coreEntries.find((candidate) =>
      candidate.commands.some((cmd) => cmd.name === primary),
    );
    if (entry) {
      const cmd = entry.commands.find((c) => c.name === primary);
      if (cmd) {
        registerLazyCoreCommand(program, ctx, entry, cmd);
      }
      return;
    }
  }

  for (const entry of coreEntries) {
    for (const cmd of entry.commands) {
      registerLazyCoreCommand(program, ctx, entry, cmd);
    }
  }
}

export function registerProgramCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[] = process.argv,
) {
  registerCoreCliCommands(program, ctx, argv);
  registerSubCliCommands(program, argv);
}
