// Core root-command descriptor catalog used for help placeholders and lazy registration.
import { isConfigMachineOutput } from "../config-output-mode.js";
import { isDoctorMachineOutput } from "../doctor-output-mode.js";
import { hasMachineOutputOption } from "../machine-output-argv.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

export const CORE_CLI_COMMAND_DESCRIPTORS = [
  {
    name: "setup",
    description: "Chat with OpenClaw; onboard when setup is incomplete",
    hasSubcommands: false,
  },
  {
    name: "crestodian", // hidden alias
    description: "Deprecated: use openclaw setup",
    hasSubcommands: false,
    hidden: true,
  },
  {
    name: "onboard",
    description: "Guided setup for auth, models, Gateway, workspace, channels, and skills",
    hasSubcommands: true,
  },
  {
    name: "configure",
    description: "Interactive configuration for credentials, channels, gateway, and agent defaults",
    hasSubcommands: false,
  },
  {
    name: "config",
    description:
      "Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup.",
    hasSubcommands: true,
    machineOutput: ({ argv }) => isConfigMachineOutput(argv),
  },
  {
    name: "claws",
    description: "Manage experimental OpenClaw Claws",
    hasSubcommands: true,
    parentDefaultHelp: true,
  },
  {
    name: "backup",
    description: "Create, verify, and restore backup archives and SQLite snapshots",
    hasSubcommands: true,
  },
  {
    name: "database",
    description: "Inspect database schema compatibility and shared-state write ownership",
    hasSubcommands: true,
    parentDefaultHelp: true,
  },
  {
    name: "migrate",
    description: "Import state from another agent system",
    hasSubcommands: true,
  },
  {
    name: "storage",
    description: "List, initialize, and test configured storage locations",
    hasSubcommands: true,
    parentDefaultHelp: true,
    machineOutput: ({ argv }) => hasMachineOutputOption(argv, "--json"),
  },
  {
    name: "doctor",
    description: "Health checks + quick fixes for the gateway and channels",
    hasSubcommands: false,
    machineOutput: isDoctorMachineOutput,
  },
  {
    name: "triage",
    description: "Collect sanitized diagnostics and open a local coding agent for repair",
    hasSubcommands: false,
    machineOutput: ({ argv }) => hasMachineOutputOption(argv, "--json"),
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
    description: "Uninstall the gateway service + local data",
    hasSubcommands: false,
  },
  {
    name: "message",
    description: "Send, read, and manage messages and channel actions",
    hasSubcommands: true,
  },
  {
    name: "mcp",
    description: "Manage OpenClaw mcp.servers config and channel bridge",
    hasSubcommands: true,
    parentDefaultHelp: true,
  },
  {
    name: "transcripts",
    description: "Inspect stored transcripts",
    hasSubcommands: true,
  },
  {
    name: "agent",
    description: "Run an agent turn via the Gateway (use --local for embedded)",
    hasSubcommands: true,
  },
  {
    name: "agents",
    description: "Manage isolated agents (workspaces + auth + routing)",
    hasSubcommands: true,
  },
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
    name: "audit",
    description: "Inspect activity records and exact-run identity context",
    hasSubcommands: false,
  },
  {
    name: "sessions",
    description: "List stored conversation sessions",
    hasSubcommands: true,
  },
] as const satisfies ReadonlyArray<NamedCommandDescriptor>;

export function getCoreCliCommandDescriptors(): ReadonlyArray<NamedCommandDescriptor> {
  return CORE_CLI_COMMAND_DESCRIPTORS;
}

export function getCoreCliCommandNamesCore(): string[] {
  return getCoreCliCommandDescriptors().map((descriptor) => descriptor.name);
}

export function getCoreCliCommandsWithSubcommands(): string[] {
  return getCoreCliCommandDescriptors()
    .filter((descriptor) => descriptor.hasSubcommands)
    .map((descriptor) => descriptor.name);
}

export function getCoreCliParentDefaultHelpCommands(): string[] {
  return getCoreCliCommandDescriptors()
    .filter((descriptor) => descriptor.parentDefaultHelp)
    .map((descriptor) => descriptor.name);
}
