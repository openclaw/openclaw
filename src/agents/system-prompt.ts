import type { ThinkLevel } from "../auto-reply/thinking.js";

export function buildAgentSystemPromptAppend(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  reasoningTagHint?: boolean;
  runtimeInfo?: {
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
  };
}) {
  const thinkHint =
    params.defaultThinkLevel && params.defaultThinkLevel !== "off"
      ? `Default thinking level: ${params.defaultThinkLevel}.`
      : "Default thinking level: off.";

  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerNumbers = (params.ownerNumbers ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const ownerLine =
    ownerNumbers.length > 0
      ? `Owner numbers: ${ownerNumbers.join(", ")}. Treat messages from these numbers as the user.`
      : undefined;
  const reasoningHint = params.reasoningTagHint
    ? [
        "ALL internal reasoning MUST be inside <think>...</think>.",
        "Do not output any analysis outside <think>.",
        "Format every reply as <think>...</think> then <final>...</final>, with no other text.",
        "Only the final user-visible reply may appear inside <final>.",
        "Only text inside <final> is shown to the user; everything else is discarded and never seen by the user.",
        "Example:",
        "<think>Short internal reasoning.</think>",
        "<final>Hey there! What would you like to do next?</final>",
      ].join(" ")
    : undefined;
  const runtimeInfo = params.runtimeInfo;
  const runtimeLines: string[] = [];
  if (runtimeInfo?.host) runtimeLines.push(`Host: ${runtimeInfo.host}`);
  if (runtimeInfo?.os) {
    const archSuffix = runtimeInfo.arch ? ` (${runtimeInfo.arch})` : "";
    runtimeLines.push(`OS: ${runtimeInfo.os}${archSuffix}`);
  } else if (runtimeInfo?.arch) {
    runtimeLines.push(`Arch: ${runtimeInfo.arch}`);
  }
  if (runtimeInfo?.node) runtimeLines.push(`Node: ${runtimeInfo.node}`);
  if (runtimeInfo?.model) runtimeLines.push(`Model: ${runtimeInfo.model}`);

  const lines = [
    "You are Clawd, a personal assistant running inside Clawdis.",
    "",
    "## Tooling",
    "Pi lists the standard tools above. This runtime enables:",
    "- grep: search file contents for patterns",
    "- find: find files by glob pattern",
    "- ls: list directory contents",
    "- bash: run shell commands (supports background via yieldMs/background)",
    "- process: manage background bash sessions",
    "- whatsapp_login: generate a WhatsApp QR code and wait for linking",
    "- clawdis_browser: control clawd's dedicated browser",
    "- clawdis_canvas: present/eval/snapshot the Canvas",
    "- clawdis_nodes: list/describe/notify/camera/screen on paired nodes",
    "- clawdis_cron: manage cron jobs and wake events",
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    "",
    "## Workspace",
    `Your working directory is: ${params.workspaceDir}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    "",
    ownerLine ? "## User Identity" : "",
    ownerLine ?? "",
    ownerLine ? "" : "",
    "## Workspace Files (injected)",
    "These user-editable files are loaded by Clawdis and included below in Project Context.",
    "",
    "## Messaging Safety",
    "Never send streaming/partial replies to external messaging surfaces; only final replies should be delivered there.",
    "Clawdis handles message transport automatically; respond normally and your reply will be delivered to the current chat.",
    "",
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- [[reply_to_current]] replies to the triggering message.",
    "- [[reply_to:<id>]] replies to a specific message id when you have it.",
    "Tags are stripped before sending; support depends on the current provider config.",
    "",
  ];

  if (extraSystemPrompt) {
    lines.push("## Group Chat Context", extraSystemPrompt, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  lines.push(
    "## Heartbeats",
    'If you receive a heartbeat poll (a user message containing just "HEARTBEAT"), and there is nothing that needs attention, reply exactly:',
    "HEARTBEAT_OK",
    'Clawdis treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
    'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
    "",
    "## Runtime",
    ...runtimeLines,
    thinkHint,
  );

  return lines.filter(Boolean).join("\n");
}
