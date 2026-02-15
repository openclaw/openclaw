import type { Command } from "commander";
import type { ProgramContext } from "./context.js";
import { buildParseArgv, getPrimaryCommand, hasHelpOrVersion } from "../argv.js";
import { resolveActionArgs } from "./helpers.js";
import { registerSubCliCommands } from "./register.subclis.js";

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
  commands: Array<{ name: string; description: string }>;
  register: (params: CommandRegisterParams) => Promise<void> | void;
};

const shouldRegisterCorePrimaryOnly = (argv: string[]) => {
  if (hasHelpOrVersion(argv)) {
    return false;
  }
  return true;
};

const coreEntries: CoreCliEntry[] = [
  {
    commands: [{ name: "setup", description: "Setup helpers" }],
    register: async ({ program }) => {
      const mod = await import("./register.setup.js");
      mod.registerSetupCommand(program);
    },
  },
  {
    commands: [{ name: "onboard", description: "Onboarding helpers" }],
    register: async ({ program }) => {
      const mod = await import("./register.onboard.js");
      mod.registerOnboardCommand(program);
    },
  },
  {
    commands: [{ name: "configure", description: "Configure wizard" }],
    register: async ({ program }) => {
      const mod = await import("./register.configure.js");
      mod.registerConfigureCommand(program);
    },
  },
  {
    commands: [{ name: "config", description: "Config helpers" }],
    register: async ({ program }) => {
      const mod = await import("../config-cli.js");
      mod.registerConfigCli(program);
    },
  },
  {
    commands: [
      { name: "doctor", description: "Health checks + quick fixes for the gateway and channels" },
      { name: "dashboard", description: "Open the Control UI with your current token" },
      { name: "reset", description: "Reset local config/state (keeps the CLI installed)" },
      {
        name: "uninstall",
        description: "Uninstall the gateway service + local data (CLI remains)",
      },
    ],
    register: async ({ program }) => {
      const mod = await import("./register.maintenance.js");
      mod.registerMaintenanceCommands(program);
    },
  },
  {
    commands: [{ name: "message", description: "Send, read, and manage messages" }],
    register: async ({ program, ctx }) => {
      const mod = await import("./register.message.js");
      mod.registerMessageCommands(program, ctx);
    },
  },
  {
    commands: [{ name: "memory", description: "Memory commands" }],
    register: async ({ program }) => {
      const mod = await import("../memory-cli.js");
      mod.registerMemoryCli(program);
    },
  },
  {
    commands: [
      { name: "agent", description: "Agent commands" },
      { name: "agents", description: "Manage isolated agents" },
    ],
    register: async ({ program, ctx }) => {
      const mod = await import("./register.agent.js");
      mod.registerAgentCommands(program, { agentChannelOptions: ctx.agentChannelOptions });
    },
  },
  {
    commands: [
      { name: "status", description: "Gateway status" },
      { name: "health", description: "Gateway health" },
      { name: "sessions", description: "Session management" },
    ],
    register: async ({ program }) => {
      const mod = await import("./register.status-health-sessions.js");
      mod.registerStatusHealthSessionsCommands(program);
    },
  },
  {
    commands: [{ name: "browser", description: "Browser tools" }],
    register: async ({ program }) => {
      const mod = await import("../browser-cli.js");
      mod.registerBrowserCli(program);
    },
  },
];

export function getCoreCliCommandNames(): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const entry of coreEntries) {
    for (const cmd of entry.commands) {
      if (seen.has(cmd.name)) {
        continue;
      }
      seen.add(cmd.name);
      names.push(cmd.name);
    }
  }
  return names;
}

function removeCommand(program: Command, command: Command) {
  const commands = program.commands as Command[];
  const index = commands.indexOf(command);
  if (index >= 0) {
    commands.splice(index, 1);
  }
}

function registerLazyCoreCommand(
  program: Command,
  ctx: ProgramContext,
  entry: CoreCliEntry,
  command: { name: string; description: string },
) {
  const placeholder = program.command(command.name).description(command.description);
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    // Some registrars install multiple top-level commands (e.g. status/health/sessions).
    // Remove placeholders/old registrations for all names in the entry before re-registering.
    for (const cmd of entry.commands) {
      const existing = program.commands.find((c) => c.name() === cmd.name);
      if (existing) {
        removeCommand(program, existing);
      }
    }
    await entry.register({ program, ctx, argv: process.argv });
    const actionCommand = actionArgs.at(-1) as Command | undefined;
    const root = actionCommand?.parent ?? program;
    const rawArgs = (root as Command & { rawArgs?: string[] }).rawArgs;
    const actionArgsList = resolveActionArgs(actionCommand);
    const fallbackArgv = actionCommand?.name()
      ? [actionCommand.name(), ...actionArgsList]
      : actionArgsList;
    const parseArgv = buildParseArgv({
      programName: program.name(),
      rawArgs,
      fallbackArgv,
    });
    await program.parseAsync(parseArgv);
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

  // Some registrars install multiple top-level commands (e.g. status/health/sessions).
  // Remove placeholders/old registrations for all names in the entry before re-registering.
  for (const cmd of entry.commands) {
    const existing = program.commands.find((c) => c.name() === cmd.name);
    if (existing) {
      removeCommand(program, existing);
    }
  }
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
