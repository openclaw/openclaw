import type { IconName } from "../icons.ts";

export type SlashCommandCategory = "session" | "model" | "agents" | "tools";

export type SlashCommandDef = {
  name: string;
  description: string;
  args?: string;
  icon?: IconName;
  category?: SlashCommandCategory;
  /** When true, the command is executed client-side via RPC instead of sent to the agent. */
  executeLocal?: boolean;
  /** Fixed argument choices for inline hints. */
  argOptions?: string[];
  /** Keyboard shortcut hint shown in the menu (display only). */
  shortcut?: string;
};

export const SLASH_COMMANDS: SlashCommandDef[] = [
  // ── Session ──
  {
    name: "new",
    description: "Start a new session",
    icon: "plus",
    category: "session",
    executeLocal: true,
  },
  {
    name: "reset",
    description: "Reset current session",
    icon: "refresh",
    category: "session",
    executeLocal: true,
  },
  {
    name: "compact",
    description: "Compact session context",
    icon: "loader",
    category: "session",
    executeLocal: true,
  },
  {
    name: "stop",
    description: "Stop current run",
    icon: "stop",
    category: "session",
    executeLocal: true,
  },
  {
    name: "clear",
    description: "Clear chat history",
    icon: "trash",
    category: "session",
    executeLocal: true,
  },
  {
    name: "focus",
    description: "Toggle focus mode",
    icon: "eye",
    category: "session",
    executeLocal: true,
  },

  // ── Model ──
  {
    name: "model",
    description: "Show or set model",
    args: "<name>",
    icon: "brain",
    category: "model",
    executeLocal: true,
  },
  {
    name: "think",
    description: "Set thinking level",
    args: "<level>",
    icon: "brain",
    category: "model",
    executeLocal: true,
    argOptions: ["off", "low", "medium", "high"],
  },
  {
    name: "verbose",
    description: "Toggle verbose mode",
    args: "<on|off|full>",
    icon: "terminal",
    category: "model",
    executeLocal: true,
    argOptions: ["on", "off", "full"],
  },

  // ── Tools ──
  {
    name: "help",
    description: "Show available commands",
    icon: "book",
    category: "tools",
    executeLocal: true,
  },
  {
    name: "status",
    description: "Show system status",
    icon: "barChart",
    category: "tools",
    executeLocal: true,
  },
  {
    name: "export",
    description: "Export session to Markdown",
    icon: "download",
    category: "tools",
    executeLocal: true,
  },
  {
    name: "usage",
    description: "Show token usage",
    icon: "barChart",
    category: "tools",
    executeLocal: true,
  },

  // ── Agents ──
  {
    name: "agents",
    description: "List agents",
    icon: "monitor",
    category: "agents",
    executeLocal: true,
  },
  {
    name: "kill",
    description: "Abort sub-agents",
    args: "<id|all>",
    icon: "x",
    category: "agents",
    executeLocal: true,
  },
  {
    name: "skill",
    description: "Run a skill",
    args: "<name>",
    icon: "zap",
    category: "tools",
  },
  {
    name: "steer",
    description: "Steer a sub-agent",
    args: "<id> <msg>",
    icon: "send",
    category: "agents",
  },
];

const CATEGORY_ORDER: SlashCommandCategory[] = ["session", "model", "tools", "agents"];

export const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  session: "Session",
  model: "Model",
  agents: "Agents",
  tools: "Tools",
};

export function getSlashCommandCompletions(filter: string): SlashCommandDef[] {
  const lower = filter.toLowerCase();
  const commands = lower
    ? SLASH_COMMANDS.filter(
        (cmd) => cmd.name.startsWith(lower) || cmd.description.toLowerCase().includes(lower),
      )
    : SLASH_COMMANDS;
  return commands.toSorted((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category ?? "session");
    const bi = CATEGORY_ORDER.indexOf(b.category ?? "session");
    if (ai !== bi) {
      return ai - bi;
    }
    // Exact prefix matches first
    if (lower) {
      const aExact = a.name.startsWith(lower) ? 0 : 1;
      const bExact = b.name.startsWith(lower) ? 0 : 1;
      if (aExact !== bExact) {
        return aExact - bExact;
      }
    }
    return 0;
  });
}

export type ParsedSlashCommand = {
  command: SlashCommandDef;
  args: string;
};

/**
 * Parse a message as a slash command. Returns null if it doesn't match.
 * Supports `/command` and `/command args...`.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const spaceIdx = trimmed.indexOf(" ");
  const name = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (!name) {
    return null;
  }

  const command = SLASH_COMMANDS.find((cmd) => cmd.name === name.toLowerCase());
  if (!command) {
    return null;
  }

  return { command, args };
}
