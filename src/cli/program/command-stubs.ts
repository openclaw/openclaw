import type { Command } from "commander";

/**
 * Lightweight command metadata for fast help rendering.
 *
 * When the user runs `openclaw help` or `openclaw --help`, Commander needs all
 * commands registered to list them.  Full registration pulls in 27 MB of JS
 * (every channel SDK, the coding-agent, AJV, etc.) just to print a string.
 *
 * Instead, we register stub commands — name + description only — which is all
 * Commander needs for the top-level help view.  Keep this list in sync with the
 * actual registrations in the register.* modules and register.subclis.ts.
 */
const COMMAND_STUBS: [name: string, description: string][] = [
  ["acp", "Agent Control Protocol tools"],
  ["agent", "Run an agent turn via the Gateway (use --local for embedded)"],
  ["agents", "Manage isolated agents (workspaces + auth + routing)"],
  ["approvals", "Exec approvals"],
  ["browser", "Manage OpenClaw's dedicated browser (Chrome/Chromium)"],
  ["channels", "Channel management"],
  ["completion", "Generate shell completion script"],
  ["config", "Config helpers (get/set/unset). Run without subcommand for the wizard."],
  ["configure", "Interactive prompt to set up credentials, devices, and agent defaults"],
  ["cron", "Cron scheduler"],
  ["daemon", "Gateway service (legacy alias)"],
  ["dashboard", "Open the Control UI with your current token"],
  ["devices", "Device pairing + token management"],
  ["directory", "Directory commands"],
  ["dns", "DNS helpers"],
  ["docs", "Docs helpers"],
  ["doctor", "Health checks + quick fixes for the gateway and channels"],
  ["gateway", "Gateway control"],
  ["health", "Fetch health from the running gateway"],
  ["hooks", "Hooks tooling"],
  ["logs", "Gateway logs"],
  ["memory", "Memory search tools"],
  ["message", "Send messages and channel actions"],
  ["models", "Model configuration"],
  ["node", "Node control"],
  ["nodes", "Node commands"],
  ["onboard", "Interactive wizard to set up the gateway, workspace, and skills"],
  ["pairing", "Pairing helpers"],
  ["plugins", "Plugin management"],
  ["reset", "Reset local config/state (keeps the CLI installed)"],
  ["sandbox", "Sandbox tools"],
  ["security", "Security helpers"],
  ["sessions", "List stored conversation sessions"],
  ["setup", "Initialize ~/.openclaw/openclaw.json and the agent workspace"],
  ["skills", "Skills management"],
  ["status", "Show channel health and recent session recipients"],
  ["system", "System events, heartbeat, and presence"],
  ["tui", "Terminal UI"],
  ["uninstall", "Uninstall the gateway service + local data (CLI remains)"],
  ["update", "CLI update helpers"],
  ["webhooks", "Webhook helpers"],
];

export function registerStubCommands(program: Command): void {
  for (const [name, description] of COMMAND_STUBS) {
    program.command(name).description(description);
  }
}
