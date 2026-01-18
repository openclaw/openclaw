import type { Command } from "commander";
import type { ClawdbotConfig } from "../../config/config.js";
import { isTruthyEnvValue } from "../../infra/env.js";
import { buildParseArgv, getPrimaryCommand, hasHelpOrVersion } from "../argv.js";
import { resolveActionArgs } from "./helpers.js";

type SubCliRegistrar = (program: Command) => Promise<void> | void;

type SubCliEntry = {
  name: string;
  description: string;
  register: SubCliRegistrar;
};

const shouldRegisterPrimaryOnly = (argv: string[]) => {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DISABLE_LAZY_SUBCOMMANDS)) return false;
  if (hasHelpOrVersion(argv)) return false;
  return true;
};

const shouldEagerRegisterSubcommands = (argv: string[]) => {
  if (isTruthyEnvValue(process.env.CLAWDBOT_DISABLE_LAZY_SUBCOMMANDS)) return true;
  if (hasHelpOrVersion(argv)) return true;
  return false;
};

const loadConfig = async (): Promise<ClawdbotConfig> => {
  const mod = await import("../../config/config.js");
  return mod.loadConfig();
};

const entries: SubCliEntry[] = [
  {
    name: "acp",
    description: "Agent Control Protocol tools",
    register: async (program) => {
      const mod = await import("../acp-cli.js");
      mod.registerAcpCli(program);
    },
  },
  {
    name: "daemon",
    description: "Manage the gateway daemon",
    register: async (program) => {
      const mod = await import("../daemon-cli.js");
      mod.registerDaemonCli(program);
    },
  },
  {
    name: "gateway",
    description: "Gateway control",
    register: async (program) => {
      const mod = await import("../gateway-cli.js");
      mod.registerGatewayCli(program);
    },
  },
  {
    name: "service",
    description: "Service helpers",
    register: async (program) => {
      const mod = await import("../service-cli.js");
      mod.registerServiceCli(program);
    },
  },
  {
    name: "logs",
    description: "Gateway logs",
    register: async (program) => {
      const mod = await import("../logs-cli.js");
      mod.registerLogsCli(program);
    },
  },
  {
    name: "models",
    description: "Model configuration",
    register: async (program) => {
      const mod = await import("../models-cli.js");
      mod.registerModelsCli(program);
    },
  },
  {
    name: "approvals",
    description: "Exec approvals",
    register: async (program) => {
      const mod = await import("../exec-approvals-cli.js");
      mod.registerExecApprovalsCli(program);
    },
  },
  {
    name: "nodes",
    description: "Node commands",
    register: async (program) => {
      const mod = await import("../nodes-cli.js");
      mod.registerNodesCli(program);
    },
  },
  {
    name: "node",
    description: "Node control",
    register: async (program) => {
      const mod = await import("../node-cli.js");
      mod.registerNodeCli(program);
    },
  },
  {
    name: "sandbox",
    description: "Sandbox tools",
    register: async (program) => {
      const mod = await import("../sandbox-cli.js");
      mod.registerSandboxCli(program);
    },
  },
  {
    name: "tui",
    description: "Terminal UI",
    register: async (program) => {
      const mod = await import("../tui-cli.js");
      mod.registerTuiCli(program);
    },
  },
  {
    name: "cron",
    description: "Cron scheduler",
    register: async (program) => {
      const mod = await import("../cron-cli.js");
      mod.registerCronCli(program);
    },
  },
  {
    name: "dns",
    description: "DNS helpers",
    register: async (program) => {
      const mod = await import("../dns-cli.js");
      mod.registerDnsCli(program);
    },
  },
  {
    name: "docs",
    description: "Docs helpers",
    register: async (program) => {
      const mod = await import("../docs-cli.js");
      mod.registerDocsCli(program);
    },
  },
  {
    name: "hooks",
    description: "Hooks tooling",
    register: async (program) => {
      const mod = await import("../hooks-cli.js");
      mod.registerHooksCli(program);
    },
  },
  {
    name: "webhooks",
    description: "Webhook helpers",
    register: async (program) => {
      const mod = await import("../webhooks-cli.js");
      mod.registerWebhooksCli(program);
    },
  },
  {
    name: "pairing",
    description: "Pairing helpers",
    register: async (program) => {
      const mod = await import("../pairing-cli.js");
      mod.registerPairingCli(program);
    },
  },
  {
    name: "plugins",
    description: "Plugin management",
    register: async (program) => {
      const mod = await import("../plugins-cli.js");
      mod.registerPluginsCli(program);
      const { registerPluginCliCommands } = await import("../../plugins/cli.js");
      registerPluginCliCommands(program, await loadConfig());
    },
  },
  {
    name: "channels",
    description: "Channel management",
    register: async (program) => {
      const mod = await import("../channels-cli.js");
      mod.registerChannelsCli(program);
    },
  },
  {
    name: "directory",
    description: "Directory commands",
    register: async (program) => {
      const mod = await import("../directory-cli.js");
      mod.registerDirectoryCli(program);
    },
  },
  {
    name: "security",
    description: "Security helpers",
    register: async (program) => {
      const mod = await import("../security-cli.js");
      mod.registerSecurityCli(program);
    },
  },
  {
    name: "skills",
    description: "Skills management",
    register: async (program) => {
      const mod = await import("../skills-cli.js");
      mod.registerSkillsCli(program);
    },
  },
  {
    name: "update",
    description: "CLI update helpers",
    register: async (program) => {
      const mod = await import("../update-cli.js");
      mod.registerUpdateCli(program);
    },
  },
];

function removeCommand(program: Command, command: Command) {
  const commands = program.commands as Command[];
  const index = commands.indexOf(command);
  if (index >= 0) {
    commands.splice(index, 1);
  }
}

function registerLazyCommand(program: Command, entry: SubCliEntry) {
  const placeholder = program.command(entry.name).description(entry.description);
  placeholder.allowUnknownOption(true);
  placeholder.allowExcessArguments(true);
  placeholder.action(async (...actionArgs) => {
    removeCommand(program, placeholder);
    await entry.register(program);
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

export function registerSubCliCommands(program: Command, argv: string[] = process.argv) {
  if (shouldEagerRegisterSubcommands(argv)) {
    for (const entry of entries) {
      void entry.register(program);
    }
    return;
  }
  const primary = getPrimaryCommand(argv);
  if (primary && shouldRegisterPrimaryOnly(argv)) {
    const entry = entries.find((candidate) => candidate.name === primary);
    if (entry) {
      registerLazyCommand(program, entry);
      return;
    }
  }
  for (const candidate of entries) {
    registerLazyCommand(program, candidate);
  }
}
