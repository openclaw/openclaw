import type { IconName } from "../icons.ts";

export type SlashCommandCategory = "session" | "model" | "agents" | "tools";

export type SlashCommandDef = {
  name: string;
  description: string;
  args?: string;
  icon?: IconName;
  category?: SlashCommandCategory;
};

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "help", description: "Show available commands", icon: "book", category: "session" },
  { name: "status", description: "Show current status", icon: "barChart", category: "session" },
  { name: "reset", description: "Reset session", icon: "refresh", category: "session" },
  { name: "compact", description: "Compact session context", icon: "loader", category: "session" },
  { name: "stop", description: "Stop current run", icon: "stop", category: "session" },
  {
    name: "model",
    description: "Show/set model",
    args: "<name>",
    icon: "brain",
    category: "model",
  },
  {
    name: "think",
    description: "Set thinking level",
    args: "<off|low|medium|high>",
    icon: "brain",
    category: "model",
  },
  {
    name: "verbose",
    description: "Toggle verbose mode",
    args: "<on|off|full>",
    icon: "terminal",
    category: "model",
  },
  { name: "export", description: "Export session to HTML", icon: "download", category: "tools" },
  {
    name: "skill",
    description: "Run a skill",
    args: "<name>",
    icon: "zap",
    category: "tools",
  },
  { name: "agents", description: "List agents", icon: "monitor", category: "agents" },
  {
    name: "kill",
    description: "Abort sub-agents",
    args: "<id|all>",
    icon: "x",
    category: "agents",
  },
  {
    name: "steer",
    description: "Steer a sub-agent",
    args: "<id> <msg>",
    icon: "send",
    category: "agents",
  },
  { name: "usage", description: "Show token usage", icon: "barChart", category: "tools" },
];

const CATEGORY_ORDER: SlashCommandCategory[] = ["session", "model", "agents", "tools"];

export const CATEGORY_LABELS: Record<SlashCommandCategory, string> = {
  session: "Session",
  model: "Model",
  agents: "Agents",
  tools: "Tools",
};

export function getSlashCommandCompletions(filter: string): SlashCommandDef[] {
  const commands = filter
    ? SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(filter.toLowerCase()))
    : SLASH_COMMANDS;
  return commands.toSorted((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category ?? "session");
    const bi = CATEGORY_ORDER.indexOf(b.category ?? "session");
    return ai - bi;
  });
}
