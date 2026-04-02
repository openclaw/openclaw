export type CoreCliCommandDescriptor = {
  name: string;
  description: string;
  hasSubcommands: boolean;
};

export const CORE_CLI_COMMAND_DESCRIPTORS = [
  {
    name: "setup",
    description: "Initialize local config and agent workspace",
    hasSubcommands: false,
  },
  {
    name: "onboard",
    description: "Interactive onboarding for gateway, workspace, and skills",
    hasSubcommands: false,
  },
  {
    name: "configure",
    description: "Interactive configuration for credentials, channels, gateway, and agent defaults",
    hasSubcommands: false,
  },
  {
    name: "config",
    description:
      "Non-interactive config helpers (get/set/unset/file/validate). Default: starts guided setup.",
    hasSubcommands: true,
  },
  {
    name: "backup",
    description: "Create and verify local backup archives for OpenClaw state",
    hasSubcommands: true,
  },
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
  {
    name: "message",
    description: "Send, read, and manage messages",
    hasSubcommands: true,
  },
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
] as const satisfies ReadonlyArray<CoreCliCommandDescriptor>;

export function getCoreCliCommandDescriptors(): ReadonlyArray<CoreCliCommandDescriptor> {
  return CORE_CLI_COMMAND_DESCRIPTORS;
}

export function getCoreCliCommandsWithSubcommands(): string[] {
  return CORE_CLI_COMMAND_DESCRIPTORS.filter((command) => command.hasSubcommands).map(
    (command) => command.name,
  );
}
