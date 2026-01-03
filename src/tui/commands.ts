import type { SlashCommand } from "@mariozechner/pi-tui";

const THINK_LEVELS = ["off", "minimal", "low", "medium", "high"];
const VERBOSE_LEVELS = ["on", "off"];
const ACTIVATION_LEVELS = ["mention", "always"];
const TOGGLE = ["on", "off"];

export type ParsedCommand = {
  name: string;
  args: string;
};

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.replace(/^\//, "").trim();
  if (!trimmed) return { name: "", args: "" };
  const [name, ...rest] = trimmed.split(/\s+/);
  return { name: name.toLowerCase(), args: rest.join(" ").trim() };
}

export function getSlashCommands(): SlashCommand[] {
  return [
    { name: "help", description: "Show slash command help" },
    { name: "status", description: "Show gateway status summary" },
    { name: "session", description: "Switch session (or open picker)" },
    { name: "sessions", description: "Open session picker" },
    {
      name: "model",
      description: "Set model (or open picker)",
    },
    { name: "models", description: "Open model picker" },
    {
      name: "think",
      description: "Set thinking level",
      getArgumentCompletions: (prefix) =>
        THINK_LEVELS.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({ value, label: value }),
        ),
    },
    {
      name: "verbose",
      description: "Set verbose on/off",
      getArgumentCompletions: (prefix) =>
        VERBOSE_LEVELS.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({ value, label: value }),
        ),
    },
    {
      name: "activation",
      description: "Set group activation",
      getArgumentCompletions: (prefix) =>
        ACTIVATION_LEVELS.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({ value, label: value }),
        ),
    },
    {
      name: "deliver",
      description: "Toggle delivery of assistant replies",
      getArgumentCompletions: (prefix) =>
        TOGGLE.filter((v) => v.startsWith(prefix.toLowerCase())).map(
          (value) => ({ value, label: value }),
        ),
    },
    { name: "abort", description: "Abort active run" },
    { name: "new", description: "Reset the session" },
    { name: "reset", description: "Reset the session" },
    { name: "settings", description: "Open settings" },
    { name: "exit", description: "Exit the TUI" },
    { name: "quit", description: "Exit the TUI" },
  ];
}

export function helpText(): string {
  return [
    "Slash commands:",
    "/help",
    "/status",
    "/session <key> (or /sessions)",
    "/model <provider/model> (or /models)",
    "/think <off|minimal|low|medium|high>",
    "/verbose <on|off>",
    "/activation <mention|always>",
    "/deliver <on|off>",
    "/new or /reset",
    "/abort",
    "/settings",
    "/exit",
  ].join("\n");
}
