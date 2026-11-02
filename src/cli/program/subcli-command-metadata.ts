// Command names and parsing/help facts stay independent of registration implementations.
import type { NamedCommandDescriptor } from "./command-group-descriptors.js";
import { isPrivateQaCliEnabled } from "./private-qa-policy.js";

type CommandMetadata = Omit<NamedCommandDescriptor, "machineOutput">;
function command<const N extends string>(
  name: N,
  description: string,
  options: Partial<Omit<CommandMetadata, "name" | "description">> = {},
) {
  return { name, description, hasSubcommands: true, ...options };
}
const commands = [
  command("acp", "Run an ACP bridge backed by the Gateway"),
  command("gateway", "Run, inspect, and query the WebSocket Gateway"),
  command("daemon", "Manage the Gateway service (launchd/systemd/schtasks)"),
  command("logs", "Tail gateway file logs via RPC", { hasSubcommands: false }),
  command("system", "System tools (events, heartbeat, presence)"),
  command("models", "Model discovery, scanning, and configuration"),
  command("promos", "Discover and claim promotional model offers from ClawHub"),
  command("telemetry", "Inspect and manage anonymous usage telemetry", { parentDefaultHelp: true }),
  command("infer", "Run provider-backed inference commands through a stable CLI surface"),
  command("capability", "Run provider capability commands (fallback alias: infer)"),
  command("approvals", "Manage approval policy and pending requests", { parentDefaultHelp: true }),
  command("exec-approvals", "Manage exec approvals (alias for approvals)"),
  command("exec-policy", "Show or synchronize requested exec policy with host approvals"),
  command("nodes", "Manage gateway-owned nodes (pairing, status, invoke, and media)"),
  command(
    "devices",
    "Device pairing and auth tokens (for mobile app setup codes, use `openclaw qr` instead)",
    { parentDefaultHelp: true },
  ),
  command("users", "Manage durable user profiles and email aliases", { parentDefaultHelp: true }),
  command("node", "Run and manage the headless node host service"),
  command("connect", "Connect this machine to an OpenClaw Gateway as a node", {
    hasSubcommands: false,
  }),
  command("worker", "Run the restricted cloud worker runtime", { hasSubcommands: false }),
  command("sandbox", "Manage sandbox containers (Docker-based agent isolation)"),
  command("worktrees", "Create, inspect, restore, and clean up managed worktrees", {
    parentDefaultHelp: true,
  }),
  command("attach", "Attach Claude Code to a gateway session with scoped MCP tools", {
    hasSubcommands: false,
  }),
  command("tui", "Open a terminal UI connected to the Gateway", { hasSubcommands: false }),
  command("resume", "Resume a recent Gateway session in the TUI", { hasSubcommands: false }),
  command("terminal", "Open a local terminal UI (alias for tui --local)", {
    hasSubcommands: false,
  }),
  command("chat", "Open a local terminal UI (alias for tui --local)", { hasSubcommands: false }),
  command("cron", "Manage automations (via Gateway)", { parentDefaultHelp: true }),
  command("automations", "Manage automations (alias for cron)", { parentDefaultHelp: true }),
  command("dns", "DNS helpers for wide-area discovery (Tailscale + CoreDNS)"),
  command("docs", "Search the live OpenClaw docs", { hasSubcommands: false }),
  command("qa", "Run QA scenarios and launch the private QA debugger UI"),
  command("proxy", "Run the OpenClaw debug proxy and inspect captured traffic"),
  command("hooks", "Manage internal agent hooks"),
  command("webhooks", "Webhook helpers and integrations"),
  command("qr", "Generate a mobile pairing QR code and setup code", { hasSubcommands: false }),
  command("clawbot", "Legacy clawbot command aliases"),
  command("pairing", "Secure DM pairing (approve inbound requests)"),
  command("plugins", "Manage OpenClaw plugins and extensions", { parentDefaultHelp: true }),
  command("channels", "Manage connected chat channels and accounts", { parentDefaultHelp: true }),
  command(
    "directory",
    "Lookup contact and group IDs (self, peers, groups) for supported chat channels",
  ),
  command("security", "Audit local config and state for common security foot-guns"),
  command("secrets", "Secrets runtime controls"),
  command("skills", "List and inspect available skills"),
  command("update", "Update OpenClaw and inspect update channel status"),
  command("completion", "Generate shell completion script", { hasSubcommands: false }),
] as const;
export type SubCliCommandName = (typeof commands)[number]["name"];
export function getSubCliCommandMetadata() {
  return isPrivateQaCliEnabled() ? commands : commands.filter((entry) => entry.name !== "qa");
}
export const SUB_CLI_COMMAND_METADATA = getSubCliCommandMetadata();
