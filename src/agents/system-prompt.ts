import type { ThinkLevel } from "../auto-reply/thinking.js";

type BootstrapFile = {
  name:
    | "AGENTS.md"
    | "SOUL.md"
    | "TOOLS.md"
    | "IDENTITY.md"
    | "USER.md"
    | "BOOTSTRAP.md";
  path: string;
  content?: string;
  missing: boolean;
};

function formatBootstrapFile(file: BootstrapFile): string {
  if (file.missing) {
    return `## ${file.name}\n\n[MISSING] Expected at: ${file.path}`;
  }
  return `## ${file.name}\n\n${file.content ?? ""}`.trimEnd();
}

function describeBuiltInTools(): string {
  // Keep this short and stable; TOOLS.md is for user-editable external tool notes.
  return [
    "- read: read file contents",
    "- bash: run shell commands",
    "- edit: apply precise in-file replacements",
    "- write: create/overwrite files",
  ].join("\n");
}

function formatDateTime(now: Date): string {
  return now.toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  bootstrapFiles: BootstrapFile[];
  now?: Date;
  defaultThinkLevel?: ThinkLevel;
}) {
  const now = params.now ?? new Date();
  const boot = params.bootstrapFiles.map(formatBootstrapFile).join("\n\n");

  const thinkHint =
    params.defaultThinkLevel && params.defaultThinkLevel !== "off"
      ? `Default thinking level: ${params.defaultThinkLevel}.`
      : "Default thinking level: off.";

  return [
    "You are Clawd, a personal assistant running inside Clawdis.",
    "",
    "## Built-in Tools (internal)",
    "These tools are always available. TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    describeBuiltInTools(),
    "",
    "## Workspace",
    `Your working directory is: ${params.workspaceDir}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    "",
    "## Workspace Files (injected)",
    "These user-editable files are loaded by Clawdis and included here directly (no separate read step):",
    boot,
    "",
    "## Messaging Safety",
    "Never send streaming/partial replies to external messaging surfaces; only final replies should be delivered there.",
    "",
    "## Heartbeats",
    'If you receive a heartbeat poll (a user message containing just "HEARTBEAT"), and there is nothing that needs attention, reply exactly:',
    "HEARTBEAT_OK",
    'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
    "",
    "## Runtime",
    `Current date and time: ${formatDateTime(now)}`,
    `Current working directory: ${params.workspaceDir}`,
    thinkHint,
  ]
    .filter(Boolean)
    .join("\n");
}
