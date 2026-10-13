// Core root-command descriptor catalog used for help placeholders and lazy registration.
import { isExperimentalClawsEnabled } from "../../claws/experimental.js";
import { isConfigMachineOutput } from "../config-output-mode.js";
import { isDoctorMachineOutput } from "../doctor-output-mode.js";
import { hasMachineOutputOption } from "../machine-output-argv.js";
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";

function command(
  name: string,
  description: string,
  hasSubcommands: boolean,
  options: Omit<NamedCommandDescriptor, "name" | "description" | "hasSubcommands"> = {},
): NamedCommandDescriptor {
  return { name, description, hasSubcommands, ...options };
}

export const CORE_CLI_COMMAND_DESCRIPTORS: readonly NamedCommandDescriptor[] = [
  command("setup", "Chat with OpenClaw; onboard when setup is incomplete", false),
  command("crestodian", "Deprecated: use openclaw setup", false, { hidden: true }),
  command(
    "onboard",
    "Guided setup for auth, models, Gateway, workspace, channels, and skills",
    true,
  ),
  command(
    "configure",
    "Interactive configuration for credentials, channels, gateway, and agent defaults",
    false,
  ),
  command(
    "config",
    "Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup.",
    true,
    { machineOutput: ({ argv }) => isConfigMachineOutput(argv) },
  ),
  command("claws", "Inspect and add experimental OpenClaw Claws", true, {
    parentDefaultHelp: true,
  }),
  command("backup", "Create, verify, and restore backup archives and SQLite snapshots", true),
  command(
    "database",
    "Inspect database schema compatibility and shared-state write ownership",
    true,
    { parentDefaultHelp: true },
  ),
  command("migrate", "Import state from another agent system", true),
  command("storage", "List, initialize, and test configured storage locations", true, {
    parentDefaultHelp: true,
    machineOutput: ({ argv }) => hasMachineOutputOption(argv, "--json"),
  }),
  command("doctor", "Health checks + quick fixes for the gateway and channels", false, {
    machineOutput: isDoctorMachineOutput,
  }),
  command(
    "triage",
    "Collect sanitized diagnostics and open a local coding agent for repair",
    false,
    {
      machineOutput: ({ argv }) => hasMachineOutputOption(argv, "--json"),
    },
  ),
  command("dashboard", "Open the Control UI with your current token", false),
  command("reset", "Reset local config/state (keeps the CLI installed)", false),
  command("uninstall", "Uninstall the gateway service + local data", false),
  command("message", "Send, read, and manage messages and channel actions", true),
  command("mcp", "Manage OpenClaw mcp.servers config and channel bridge", true, {
    parentDefaultHelp: true,
  }),
  command("transcripts", "Inspect stored transcripts", true),
  command("agent", "Run an agent turn via the Gateway (use --local for embedded)", true),
  command("agents", "Manage isolated agents (workspaces + auth + routing)", true),
  command("status", "Show channel health and recent session recipients", false),
  command("health", "Fetch health from the running gateway", false),
  command("audit", "Inspect activity records and exact-run identity context", false),
  command("sessions", "List stored conversation sessions", true),
];

export function getCoreCliCommandDescriptors(): ReadonlyArray<NamedCommandDescriptor> {
  return isExperimentalClawsEnabled()
    ? CORE_CLI_COMMAND_DESCRIPTORS
    : CORE_CLI_COMMAND_DESCRIPTORS.filter((descriptor) => descriptor.name !== "claws");
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
