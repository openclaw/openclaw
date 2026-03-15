import { createHmac, createHash } from "node:crypto";
import type { ReasoningLevel, ThinkLevel } from "../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { MemoryCitationsMode } from "../config/types.memory.js";
import { listDeliverableMessageChannels } from "../utils/message-channel.js";
import type { ResolvedTimeFormat } from "./date-time.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { EmbeddedSandboxInfo } from "./pi-embedded-runner/types.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (Tooling, Workspace, Runtime) - used for subagents
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";
type OwnerIdDisplay = "raw" | "hash";

function buildSkillsSection(params: { skillsPrompt?: string; readToolName: string }) {
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) {
    return [];
  }
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    "- When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.",
    trimmed,
    "",
  ];
}

function buildMemorySection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  citationsMode?: MemoryCitationsMode;
}) {
  if (params.isMinimal) {
    return [];
  }
  if (!params.availableTools.has("memory_search") && !params.availableTools.has("memory_get")) {
    return [];
  }
  const lines = [
    "## Memory Recall",
    "Before answering anything about prior work, decisions, dates, people, preferences, or todos: run memory_search on MEMORY.md + memory/*.md; then use memory_get to pull only the needed lines. If low confidence after search, say you checked.",
  ];
  if (params.citationsMode === "off") {
    lines.push(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
}

function buildUserIdentitySection(ownerLine: string | undefined, isMinimal: boolean) {
  if (!ownerLine || isMinimal) {
    return [];
  }
  return ["## Authorized Senders", ownerLine, ""];
}

function formatOwnerDisplayId(ownerId: string, ownerDisplaySecret?: string) {
  const hasSecret = ownerDisplaySecret?.trim();
  const digest = hasSecret
    ? createHmac("sha256", hasSecret).update(ownerId).digest("hex")
    : createHash("sha256").update(ownerId).digest("hex");
  return digest.slice(0, 12);
}

function buildOwnerIdentityLine(
  ownerNumbers: string[],
  ownerDisplay: OwnerIdDisplay,
  ownerDisplaySecret?: string,
) {
  const normalized = ownerNumbers.map((value) => value.trim()).filter(Boolean);
  if (normalized.length === 0) {
    return undefined;
  }
  const displayOwnerNumbers =
    ownerDisplay === "hash"
      ? normalized.map((ownerId) => formatOwnerDisplayId(ownerId, ownerDisplaySecret))
      : normalized;
  return `Authorized senders: ${displayOwnerNumbers.join(", ")}. These senders are allowlisted; do not assume they are the owner.`;
}

function buildTimeSection(params: { userTimezone?: string }) {
  if (!params.userTimezone) {
    return [];
  }
  return ["## Time Zone", `Time zone: ${params.userTimezone}`, ""];
}

function buildReplyTagsSection(isMinimal: boolean) {
  if (isMinimal) {
    return [];
  }
  return [
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- Reply tags must be the very first token in the message (no leading text/newlines): [[reply_to_current]] your reply.",
    "- [[reply_to_current]] replies to the triggering message.",
    "- Prefer [[reply_to_current]]. Use [[reply_to:<id>]] only when an id was explicitly provided (e.g. by the user or a tool).",
    "Whitespace inside the tag is allowed (e.g. [[ reply_to_current ]] / [[ reply_to: 123 ]]).",
    "Tags are stripped before sending; support depends on the current channel config.",
    "",
  ];
}

function buildMessagingSection(params: {
  isMinimal: boolean;
  availableTools: Set<string>;
  messageChannelOptions: string;
  // Note: inlineButtonsEnabled, runtimeChannel, and messageToolHints are NOT included here —
  // they are per-channel/per-conversation and are injected in the dynamic tail
  // (after workspace files) for KV-cache stability.
}) {
  if (params.isMinimal) {
    return [];
  }
  return [
    "## Messaging",
    "- Reply in current session → automatically routes to the source channel (Signal, Telegram, etc.)",
    "- Cross-session messaging → use sessions_send(sessionKey, message)",
    "- Sub-agent orchestration → use subagents(action=list|steer|kill)",
    `- Runtime-generated completion events may ask for a user update. Rewrite those in your normal assistant voice and send the update (do not forward raw internal metadata or default to ${SILENT_REPLY_TOKEN}).`,
    "- Never use exec/curl for provider messaging; OpenClaw handles all routing internally.",
    params.availableTools.has("message")
      ? [
          "",
          "### message tool",
          "- Use `message` for proactive sends + channel actions (polls, reactions, etc.).",
          "- For `action=send`, include `to` and `message`.",
          `- If multiple channels are configured, pass \`channel\` (${params.messageChannelOptions}).`,
          `- If you use \`message\` (\`action=send\`) to deliver your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies).`,
          // Inline buttons status and messageToolHints injected in dynamic tail
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    "",
  ];
}

function buildVoiceSection(params: { isMinimal: boolean }) {
  // Note: ttsHint content is NOT included here — it is per-session/per-config and is
  // injected in the dynamic tail (after workspace files) for KV-cache stability.
  // This function is kept for future stable voice-section content.
  void params;
  return [];
}

function buildDocsSection(params: { docsPath?: string; isMinimal: boolean; readToolName: string }) {
  const docsPath = params.docsPath?.trim();
  if (!docsPath || params.isMinimal) {
    return [];
  }
  return [
    "## Documentation",
    `OpenClaw docs: ${docsPath}`,
    "Mirror: https://docs.openclaw.ai",
    "Source: https://github.com/openclaw/openclaw",
    "Community: https://discord.com/invite/clawd",
    "Find new skills: https://clawhub.com",
    "For OpenClaw behavior, commands, config, or architecture: consult local docs first.",
    "When diagnosing issues, run `openclaw status` yourself when possible; only ask the user if you lack access (e.g., sandboxed).",
    "",
  ];
}

export function buildAgentSystemPrompt(params: {
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  ownerDisplay?: OwnerIdDisplay;
  ownerDisplaySecret?: string;
  reasoningTagHint?: boolean;
  toolNames?: string[];
  toolSummaries?: Record<string, string>;
  modelAliasLines?: string[];
  userTimezone?: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  bootstrapTruncationWarningLines?: string[];
  skillsPrompt?: string;
  heartbeatPrompt?: string;
  docsPath?: string;
  workspaceNotes?: string[];
  ttsHint?: string;
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  /** Whether ACP-specific routing guidance should be included. Defaults to true. */
  acpEnabled?: boolean;
  runtimeInfo?: {
    agentId?: string;
    host?: string;
    os?: string;
    arch?: string;
    node?: string;
    model?: string;
    defaultModel?: string;
    shell?: string;
    channel?: string;
    capabilities?: string[];
    repoRoot?: string;
  };
  messageToolHints?: string[];
  sandboxInfo?: EmbeddedSandboxInfo;
  /** Reaction guidance for the agent (for Telegram minimal/extensive modes). */
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  memoryCitationsMode?: MemoryCitationsMode;
}) {
  const acpEnabled = params.acpEnabled !== false;
  // ACP guidance is stable regardless of sandboxedRuntime; sandbox constraints go in ## Sandbox.
  const coreToolSummaries: Record<string, string> = {
    read: "Read file contents",
    write: "Create or overwrite files",
    edit: "Make precise edits to files",
    apply_patch: "Apply multi-file patches",
    grep: "Search file contents for patterns",
    find: "Find files by glob pattern",
    ls: "List directory contents",
    exec: "Run shell commands (pty available for TTY-required CLIs)",
    process: "Manage background exec sessions",
    web_search: "Search the web (Brave API)",
    web_fetch: "Fetch and extract readable content from a URL",
    // Channel docking: add login tools here when a channel needs interactive linking.
    browser: "Control web browser",
    canvas: "Present/eval/snapshot the Canvas",
    nodes: "List/describe/notify/camera/screen on paired nodes",
    cron: "Manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
    message: "Send messages and channel actions",
    gateway: "Restart, apply config, or run updates on the running OpenClaw process",
    // Tool descriptions stable w.r.t. sandbox mode (sandboxedRuntime) for KV-cache reuse.
    // Sandbox constraints are communicated in ## Sandbox section (dynamic tail).
    // acpEnabled=false (deployment config) still uses shorter non-ACP descriptions.
    agents_list: acpEnabled
      ? 'List OpenClaw agent ids allowed for sessions_spawn when runtime="subagent" (not ACP harness ids)'
      : "List OpenClaw agent ids allowed for sessions_spawn",
    sessions_list: "List other sessions (incl. sub-agents) with filters/last",
    sessions_history: "Fetch history for another session/sub-agent",
    sessions_send: "Send a message to another session/sub-agent",
    sessions_spawn: acpEnabled
      ? 'Spawn an isolated sub-agent or ACP coding session (runtime="acp" requires `agentId` unless `acp.defaultAgent` is configured; ACP harness ids follow acp.allowedAgents, not agents_list)'
      : "Spawn an isolated sub-agent session",
    subagents: "List, steer, or kill sub-agent runs for this requester session",
    session_status:
      "Show a /status-equivalent status card (usage + time + Reasoning/Verbose/Elevated); use for model-use questions (📊 session_status); optional per-session model override",
    image: "Analyze an image with the configured image model",
    memory_search: "Search memory files for relevant context",
    memory_get: "Retrieve specific memory file contents",
  };

  const toolOrder = [
    "read",
    "write",
    "edit",
    "apply_patch",
    "grep",
    "find",
    "ls",
    "exec",
    "process",
    "web_search",
    "web_fetch",
    "browser",
    "canvas",
    "nodes",
    "cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "subagents",
    "session_status",
    "image",
    "memory_search",
    "memory_get",
  ];

  const rawToolNames = (params.toolNames ?? []).map((tool) => tool.trim());
  const canonicalToolNames = rawToolNames.filter(Boolean);
  // Preserve caller casing while deduping tool names by lowercase.
  const canonicalByNormalized = new Map<string, string>();
  for (const name of canonicalToolNames) {
    const normalized = name.toLowerCase();
    if (!canonicalByNormalized.has(normalized)) {
      canonicalByNormalized.set(normalized, name);
    }
  }
  const resolveToolName = (normalized: string) =>
    canonicalByNormalized.get(normalized) ?? normalized;

  const normalizedTools = canonicalToolNames.map((tool) => tool.toLowerCase());
  const availableTools = new Set(normalizedTools);
  const hasSessionsSpawn = availableTools.has("sessions_spawn");
  // Stable regardless of sandboxedRuntime — ACP guidance in tooling/guidance block is always
  // included when ACP is enabled. Sandbox constraints are in ## Sandbox section (dynamic tail).
  const acpHarnessSpawnAllowed = hasSessionsSpawn && acpEnabled;
  const externalToolSummaries = new Map<string, string>();
  for (const [key, value] of Object.entries(params.toolSummaries ?? {})) {
    const normalized = key.trim().toLowerCase();
    if (!normalized || !value?.trim()) {
      continue;
    }
    externalToolSummaries.set(normalized, value.trim());
  }
  const extraTools = Array.from(
    new Set(normalizedTools.filter((tool) => !toolOrder.includes(tool))),
  );
  const enabledTools = toolOrder.filter((tool) => availableTools.has(tool));
  const toolLines = enabledTools.map((tool) => {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    return summary ? `- ${name}: ${summary}` : `- ${name}`;
  });
  for (const tool of extraTools.toSorted()) {
    const summary = coreToolSummaries[tool] ?? externalToolSummaries.get(tool);
    const name = resolveToolName(tool);
    toolLines.push(summary ? `- ${name}: ${summary}` : `- ${name}`);
  }

  const hasGateway = availableTools.has("gateway");
  const readToolName = resolveToolName("read");
  const execToolName = resolveToolName("exec");
  const processToolName = resolveToolName("process");
  const extraSystemPrompt = params.extraSystemPrompt?.trim();
  const ownerDisplay = params.ownerDisplay === "hash" ? "hash" : "raw";
  const ownerLine = buildOwnerIdentityLine(
    params.ownerNumbers ?? [],
    ownerDisplay,
    params.ownerDisplaySecret,
  );
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
  const reasoningLevel = params.reasoningLevel ?? "off";
  const userTimezone = params.userTimezone?.trim();
  const skillsPrompt = params.skillsPrompt?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const runtimeInfo = params.runtimeInfo;
  const runtimeChannel = runtimeInfo?.channel?.trim().toLowerCase();
  const runtimeCapabilities = (runtimeInfo?.capabilities ?? [])
    .map((cap) => String(cap).trim())
    .filter(Boolean);
  const runtimeCapabilitiesLower = new Set(runtimeCapabilities.map((cap) => cap.toLowerCase()));
  const inlineButtonsEnabled = runtimeCapabilitiesLower.has("inlinebuttons");
  const messageChannelOptions = listDeliverableMessageChannels().join("|");
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";
  const sandboxContainerWorkspace = params.sandboxInfo?.containerWorkspaceDir?.trim();
  const sanitizedWorkspaceDir = sanitizeForPromptLiteral(params.workspaceDir);
  const sanitizedSandboxContainerWorkspace = sandboxContainerWorkspace
    ? sanitizeForPromptLiteral(sandboxContainerWorkspace)
    : "";
  const displayWorkspaceDir =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? sanitizedSandboxContainerWorkspace
      : sanitizedWorkspaceDir;
  const workspaceGuidance =
    params.sandboxInfo?.enabled && sanitizedSandboxContainerWorkspace
      ? `For read/write/edit/apply_patch, file paths resolve against host workspace: ${sanitizedWorkspaceDir}. For bash/exec commands, use sandbox container paths under ${sanitizedSandboxContainerWorkspace} (or relative paths from that workdir), not host paths. Prefer relative paths so both sandboxed exec and file tools work consistently.`
      : "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.";
  const safetySection = [
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",
  ];
  const skillsSection = buildSkillsSection({
    skillsPrompt,
    readToolName,
  });
  const memorySection = buildMemorySection({
    isMinimal,
    availableTools,
    citationsMode: params.memoryCitationsMode,
  });
  const docsSection = buildDocsSection({
    docsPath: params.docsPath,
    isMinimal,
    readToolName,
  });
  const workspaceNotes = (params.workspaceNotes ?? []).map((note) => note.trim()).filter(Boolean);

  // For "none" mode, return just the basic identity line
  if (promptMode === "none") {
    return "You are a personal assistant running inside OpenClaw.";
  }

  const lines = [
    "You are a personal assistant running inside OpenClaw.",
    "",
    "## Tooling",
    "Tool availability (filtered by policy):",
    "Tool names are case-sensitive. Call tools exactly as listed.",
    // Tool listing is injected in the dynamic tail (after workspace files) for KV-cache
    // stability. When a new plugin is installed (new tool added), only the tail is invalidated.
    // See "## Tool Manifest" section injected after workspace files.
    toolLines.length > 0
      ? "(Available tools listed in Tool Manifest section below.)"
      : [
          "Pi lists the standard tools above. This runtime enables:",
          "- grep: search file contents for patterns",
          "- find: find files by glob pattern",
          "- ls: list directory contents",
          "- apply_patch: apply multi-file patches",
          `- ${execToolName}: run shell commands (supports background via yieldMs/background)`,
          `- ${processToolName}: manage background exec sessions`,
          "- browser: control OpenClaw's dedicated browser",
          "- canvas: present/eval/snapshot the Canvas",
          "- nodes: list/describe/notify/camera/screen on paired nodes",
          "- cron: manage cron jobs and wake events (use for reminders; when scheduling a reminder, write the systemEvent text as something that will read like a reminder when it fires, and mention that it is a reminder depending on the time gap between setting and firing; include recent context in reminder text if appropriate)",
          "- sessions_list: list sessions",
          "- sessions_history: fetch session history",
          "- sessions_send: send to another session",
          "- subagents: list/steer/kill sub-agent runs",
          '- session_status: show usage/time/model state and answer "what model are we using?"',
        ].join("\n"),
    "TOOLS.md does not control tool availability; it is user guidance for how to use external tools.",
    `For long waits, avoid rapid poll loops: use ${execToolName} with enough yieldMs or ${processToolName}(action=poll, timeout=<ms>).`,
    "If a task is more complex or takes longer, spawn a sub-agent. Completion is push-based: it will auto-announce when done.",
    // ACP harness guidance: stable regardless of sandbox mode.
    // Sandbox-specific constraints (ACP blocked) are communicated in ## Sandbox section.
    ...(acpHarnessSpawnAllowed
      ? [
          'For requests like "do this in codex/claude code/gemini", treat it as ACP harness intent and call `sessions_spawn` with `runtime: "acp"`.',
          'On Discord, default ACP harness requests to thread-bound persistent sessions (`thread: true`, `mode: "session"`) unless the user asks otherwise.',
          "Set `agentId` explicitly unless `acp.defaultAgent` is configured, and do not route ACP harness requests through `subagents`/`agents_list` or local PTY exec flows.",
          'For ACP harness thread spawns, do not call `message` with `action=thread-create`; use `sessions_spawn` (`runtime: "acp"`, `thread: true`) as the single thread creation path.',
        ]
      : []),
    "Do not poll `subagents list` / `sessions_list` in a loop; only check status on-demand (for intervention, debugging, or when explicitly asked).",
    "",
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "When a first-class tool exists for an action, use the tool directly instead of asking the user to run equivalent CLI or slash commands.",
    "When exec returns approval-pending, include the concrete /approve command from tool output (with allow-once|allow-always|deny) and do not ask for a different or rotated code.",
    "Treat allow-once as single-command only: if another elevated command needs approval, request a fresh /approve and do not claim prior approval covered it.",
    "When approvals are required, preserve and show the full command/script exactly as provided (including chained operators like &&, ||, |, ;, or multiline shells) so the user can approve what will actually run.",
    "",
    ...safetySection,
    "## OpenClaw CLI Quick Reference",
    "OpenClaw is controlled via subcommands. Do not invent commands.",
    "To manage the Gateway daemon service (start/stop/restart):",
    "- openclaw gateway status",
    "- openclaw gateway start",
    "- openclaw gateway stop",
    "- openclaw gateway restart",
    "If unsure, ask the user to run `openclaw help` (or `openclaw gateway --help`) and paste the output.",
    "",
    ...memorySection,
    // Skip self-update for subagent/none modes
    hasGateway && !isMinimal ? "## OpenClaw Self-Update" : "",
    hasGateway && !isMinimal
      ? [
          "Get Updates (self-update) is ONLY allowed when the user explicitly asks for it.",
          "Do not run config.apply or update.run unless the user explicitly requests an update or config change; if it's not explicit, ask first.",
          "Use config.schema.lookup with a specific dot path to inspect only the relevant config subtree before making config changes or answering config-field questions; avoid guessing field names/types.",
          "Actions: config.schema.lookup, config.get, config.apply (validate + write full config, then restart), config.patch (partial update, merges with existing), update.run (update deps or git, then restart).",
          "After restart, OpenClaw pings the last active session automatically.",
        ].join("\n")
      : "",
    hasGateway && !isMinimal ? "" : "",
    "",
    // Note: skillsSection and modelAliasLines are injected in the dynamic tail (after
    // workspace files) for KV-cache stability. Skills and model aliases change when
    // users install new skills or update model preferences; placing them after workspace
    // files ensures SOUL.md, AGENTS.md, and boilerplate remain in the cached prefix.
    userTimezone
      ? "If you need the current date, time, or day of week, run session_status (📊 session_status)."
      : "",
    "## Workspace",
    `Your working directory is: ${displayWorkspaceDir}`,
    workspaceGuidance,
    // Note: workspaceNotes are injected in the dynamic tail (after workspace files) for
    // KV-cache stability. Project notes change when users update sprint/project config;
    // placing them after AGENTS.md ensures stable workspace files stay in the cached prefix.
    "",
    // Note: docsSection, ## Authorized Senders, and ## Sandbox are injected in the dynamic
    // tail (after workspace files) for KV-cache stability. These are deployment-level config
    // that changes rarely (docs path changes on upgrades, authorized senders on device setup,
    // sandbox on container config changes). Placing them in the dynamic tail ensures that
    // workspace files and stable boilerplate remain in the Anthropic KV-cached prefix.
    "## Workspace Files (injected)",
    "These user-editable files are loaded by OpenClaw and included below in Project Context.",
    "",
    ...buildReplyTagsSection(isMinimal),
    ...buildMessagingSection({
      isMinimal,
      availableTools,
      messageChannelOptions,
    }),
    ...buildVoiceSection({ isMinimal }),
  ];

  // Note: extraSystemPrompt, reactionGuidance, and reasoningHint are injected AFTER
  // workspace files (see below) so they don't break the stable KV-cache prefix.
  // These change per conversation/session, so they must come after stable workspace files.

  // Skip silent replies for subagent/none modes
  // Placed BEFORE Project Context so this stable boilerplate is cached even when
  // workspace files change between sessions.
  if (!isMinimal) {
    lines.push(
      "## Silent Replies",
      `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
      "",
      "⚠️ Rules:",
      "- It must be your ENTIRE message — nothing else",
      `- Never append it to an actual response (never include "${SILENT_REPLY_TOKEN}" in real replies)`,
      "- Never wrap it in markdown or code blocks",
      "",
      `❌ Wrong: "Here's help... ${SILENT_REPLY_TOKEN}"`,
      `❌ Wrong: "${SILENT_REPLY_TOKEN}"`,
      `✅ Right: ${SILENT_REPLY_TOKEN}`,
      "",
    );
  }

  // Skip heartbeats for subagent/none modes
  // Placed BEFORE Project Context so this stable boilerplate is cached even when
  // workspace files change between sessions.
  if (!isMinimal) {
    lines.push(
      "## Heartbeats",
      heartbeatPromptLine,
      "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
      "HEARTBEAT_OK",
      'OpenClaw treats a leading/trailing "HEARTBEAT_OK" as a heartbeat ack (and may discard it).',
      'If something needs attention, do NOT include "HEARTBEAT_OK"; reply with the alert text instead.',
      "",
    );
  }

  // Keep dynamic runtime metadata after all stable boilerplate so Anthropic can reuse
  // the maximum stable prefix across sessions.
  // Order: stable fields → Reasoning (often stable) → dynamic per-session fields (model, agentId).
  lines.push(
    ...buildTimeSection({
      userTimezone,
    }),
    "## Runtime",
    buildRuntimeLine(runtimeInfo),
    "Reasoning: configurable (off|on|stream, default off). Toggle /reasoning; /status shows current level.",
  );

  // Project Context (workspace bootstrap files) is placed LAST in the stable-prefix-ordered
  // prompt. Workspace files change between sessions (daily notes, project status, MEMORY.md).
  // By pushing them after all stable boilerplate (Silent Replies, Heartbeats, Runtime), those
  // sections remain in the Anthropic KV-cached stable prefix even when workspace files change.
  const contextFiles = params.contextFiles ?? [];
  const bootstrapTruncationWarningLines = (params.bootstrapTruncationWarningLines ?? []).filter(
    (line) => line.trim().length > 0,
  );
  const validContextFiles = contextFiles.filter(
    (file) => typeof file.path === "string" && file.path.trim().length > 0,
  );

  // Separate memory files (MEMORY.md / memory.md) from standard workspace files.
  // Memory files change daily (updated notes) while standard files change rarely.
  // By injecting memory files AFTER the per-conversation dynamic tail, we ensure the
  // stable prefix includes all standard workspace files + AGENTS.md + the full dynamic
  // tail — so that a daily notes update only invalidates the very end of the prompt.
  const isMemoryFile = (file: { path: string }) => {
    const p = file.path.trim().replace(/\\/g, "/");
    const base = (p.split("/").pop() ?? p).toLowerCase();
    return base === "memory.md";
  };
  const standardContextFiles = validContextFiles.filter((f) => !isMemoryFile(f));
  const memoryContextFiles = validContextFiles.filter(isMemoryFile);

  if (standardContextFiles.length > 0 || bootstrapTruncationWarningLines.length > 0) {
    lines.push("# Project Context", "");
    if (standardContextFiles.length > 0) {
      const hasSoulFile = standardContextFiles.some((file) => {
        const normalizedPath = file.path.trim().replace(/\\/g, "/");
        const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
        return baseName.toLowerCase() === "soul.md";
      });
      // Emit a stable file manifest before the first per-file header.
      // Basenames of standard workspace files are fixed by the loader; listing them here
      // extends the stable Anthropic KV-cache prefix by the length of the manifest, while
      // still giving the agent a quick reference of which files are loaded.
      // Only list standard files here — memory files (MEMORY.md, daily notes) are injected
      // at the end of the prompt for KV-cache stability and are not adjacent to Project Context.
      const fileNames = standardContextFiles.map((f) => {
        const p = f.path.trim().replace(/\\/g, "/");
        return p.split("/").pop() ?? p;
      });
      const memoryFileNames = memoryContextFiles.map((f) => {
        const p = f.path.trim().replace(/\\/g, "/");
        return p.split("/").pop() ?? p;
      });
      const memoryNote =
        memoryFileNames.length > 0 ? ` (${memoryFileNames.join(", ")} injected at end)` : "";
      lines.push(
        "The following project context files have been loaded:",
        `Files: ${fileNames.join(", ")}${memoryNote}`,
      );
      if (hasSoulFile) {
        lines.push(
          "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
        );
      }
      lines.push("");
    }
    if (bootstrapTruncationWarningLines.length > 0) {
      lines.push("⚠ Bootstrap truncation warning:");
      for (const warningLine of bootstrapTruncationWarningLines) {
        lines.push(`- ${warningLine}`);
      }
      lines.push("");
    }
    for (const file of standardContextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // Dynamic per-session fields on a final line so the stable prefix above can be KV-cached.
  const dynamicLine = buildRuntimeDynamicLine(
    runtimeInfo,
    params.defaultThinkLevel,
    reasoningLevel,
  );
  if (dynamicLine) {
    lines.push(dynamicLine);
  }

  // ── Per-conversation dynamic context (injected LAST for KV-cache stability) ──
  // These fields change per conversation or session configuration. Placing them after
  // workspace files and the runtime line ensures the large stable prefix (workspace
  // files + boilerplate, ~28k chars) remains cached even when these change.

  // Per-channel message tool content: inline buttons and hints vary by channel capabilities
  if (availableTools.has("message")) {
    // Inline buttons status depends on inlineButtonsEnabled (a per-conversation capability)
    const inlineButtonsLine = inlineButtonsEnabled
      ? "- Inline buttons supported. Use `action=send` with `buttons=[[{text,callback_data,style?}]]`; `style` can be `primary`, `success`, or `danger`."
      : runtimeChannel
        ? '- Inline buttons not enabled on this channel. To enable, ask to set capabilities.inlineButtons ("dm"|"group"|"all"|"allowlist").'
        : "";
    if (inlineButtonsLine) {
      lines.push(inlineButtonsLine);
    }
  }
  // Per-channel message tool hints (vary by channel: WhatsApp vs Telegram vs iMessage)
  if (params.messageToolHints?.length) {
    // Append as continuation of the message tool section in the dynamic tail
    for (const hint of params.messageToolHints) {
      if (hint.trim()) {
        lines.push(hint.trim());
      }
    }
    lines.push("");
  }

  // Voice/TTS configuration (per deployment config; changes when voice is enabled/reconfigured)
  const ttsHint = params.ttsHint?.trim();
  if (ttsHint && !isMinimal) {
    lines.push("## Voice (TTS)", ttsHint, "");
  }

  // ## Reactions, ## Reasoning Format, and ## Tool Manifest are per-channel/per-session/
  // per-deployment config — they do NOT change per-conversation (different group chat,
  // same channel+reasoning+plugins). Placing them BEFORE extraSystemPrompt keeps them in
  // the stable KV-cache prefix when only the group chat context changes.
  // Tool Manifest changes RARELY (plugin install) vs GroupChat changes EVERY SESSION.
  // Gain: ~2,000 chars added to per-conv stable prefix; cost: ~230 chars less for toolNames.
  if (params.reactionGuidance) {
    const { level, channel } = params.reactionGuidance;
    const guidanceText =
      level === "minimal"
        ? [
            `Reactions are enabled for ${channel} in MINIMAL mode.`,
            "React ONLY when truly relevant:",
            "- Acknowledge important user requests or confirmations",
            "- Express genuine sentiment (humor, appreciation) sparingly",
            "- Avoid reacting to routine messages or your own replies",
            "Guideline: at most 1 reaction per 5-10 exchanges.",
          ].join("\n")
        : [
            `Reactions are enabled for ${channel} in EXTENSIVE mode.`,
            "Feel free to react liberally:",
            "- Acknowledge messages with appropriate emojis",
            "- Express sentiment and personality through reactions",
            "- React to interesting content, humor, or notable events",
            "- Use reactions to confirm understanding or agreement",
            "Guideline: react whenever it feels natural.",
          ].join("\n");
    lines.push("## Reactions", guidanceText, "");
  }
  if (reasoningHint) {
    lines.push("## Reasoning Format", reasoningHint, "");
  }

  // Tool Manifest: BEFORE GroupChat — plugin set changes RARELY vs per-conv every session.
  if (toolLines.length > 0) {
    lines.push("## Tool Manifest", toolLines.join("\n"), "");
  }

  // ── Post-conversation dynamic tail ────────────────────────────────────────────
  // Ordering: frequency ascending (least frequent = FIRST, most frequent = LAST).
  // GroupChat goes ABSOLUTELY LAST — the most frequently-changing section.
  //
  //   0. Deployment config (docs/owners/sandbox) — YEARLY  [before channel= in prev sessions;
  //      now placed HERE so it's also in the stable prefix for per-conv and gains ~3k chars
  //      from tool listing being before it — deployConfig scenario improves from 87%→98%]
  //   1. Model Aliases — QUARTERLY
  //   2. Skills (mandatory) — MONTHLY
  //   3. Project Notes (workspaceNotes) — WEEKLY
  //   4. MEMORY.md — DAILY
  //   5. GroupChat / SubagentContext — PER-CONVERSATION (multiple times/day, goes LAST)

  // 0. Deployment config: yearly changes (docs path update, adding a device, sandbox toggle).
  // Placed here (after TM, before modelAliases) so it gains the benefit of TM's stable content
  // and is still before the more-frequent per-session/per-conversation sections.
  if (!isMinimal) {
    lines.push(...docsSection);
  }
  if (ownerLine && !isMinimal) {
    lines.push(...buildUserIdentitySection(ownerLine, isMinimal));
  }
  if (params.sandboxInfo?.enabled) {
    lines.push("## Sandbox");
    lines.push(
      [
        "You are running in a sandboxed runtime (tools execute in Docker).",
        "Some tools may be unavailable due to sandbox policy.",
        "Sub-agents stay sandboxed (no elevated/host access). Need outside-sandbox read/write? Don't spawn; ask first.",
        acpHarnessSpawnAllowed
          ? 'ACP harness spawns are blocked from sandboxed sessions (`sessions_spawn` with `runtime: "acp"`). Use `runtime: "subagent"` instead.'
          : "",
        params.sandboxInfo.containerWorkspaceDir
          ? `Sandbox container workdir: ${sanitizeForPromptLiteral(params.sandboxInfo.containerWorkspaceDir)}`
          : "",
        params.sandboxInfo.workspaceDir
          ? `Sandbox host mount source (file tools bridge only; not valid inside sandbox exec): ${sanitizeForPromptLiteral(params.sandboxInfo.workspaceDir)}`
          : "",
        params.sandboxInfo.workspaceAccess
          ? `Agent workspace access: ${params.sandboxInfo.workspaceAccess}${
              params.sandboxInfo.agentWorkspaceMount
                ? ` (mounted at ${sanitizeForPromptLiteral(params.sandboxInfo.agentWorkspaceMount)})`
                : ""
            }`
          : "",
        params.sandboxInfo.browserBridgeUrl ? "Sandbox browser: enabled." : "",
        params.sandboxInfo.browserNoVncUrl
          ? `Sandbox browser observer (noVNC): ${sanitizeForPromptLiteral(params.sandboxInfo.browserNoVncUrl)}`
          : "",
        params.sandboxInfo.hostBrowserAllowed === true
          ? "Host browser control: allowed."
          : params.sandboxInfo.hostBrowserAllowed === false
            ? "Host browser control: blocked."
            : "",
        params.sandboxInfo.elevated?.allowed ? "Elevated exec is available for this session." : "",
        params.sandboxInfo.elevated?.allowed
          ? "User can toggle with /elevated on|off|ask|full."
          : "",
        params.sandboxInfo.elevated?.allowed
          ? "You may also send /elevated on|off|ask|full when needed."
          : "",
        params.sandboxInfo.elevated?.allowed
          ? `Current elevated level: ${params.sandboxInfo.elevated.defaultLevel} (ask runs exec on host with approvals; full auto-approves).`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    lines.push("");
  }

  // 1. Model aliases: quarterly changes (model preference updates).
  if (!isMinimal && params.modelAliasLines && params.modelAliasLines.length > 0) {
    lines.push(
      "## Model Aliases",
      "Prefer aliases when specifying model overrides; full provider/model is also accepted.",
      params.modelAliasLines.join("\n"),
      "",
    );
  }

  // 2. Skills: monthly changes (skill installations from Clawhub).
  // Included in ALL prompt modes (cron/subagent sessions need skills too).
  if (skillsSection.length > 0) {
    lines.push(...skillsSection);
  }

  // 3. Project Notes (workspaceNotes): weekly changes (sprint/project updates).
  if (workspaceNotes.length > 0) {
    lines.push("## Project Notes", "");
    for (const note of workspaceNotes) {
      lines.push(note);
    }
    lines.push("");
  }

  // 4. Memory files (MEMORY.md / memory.md) — DAILY changes.
  for (const file of memoryContextFiles) {
    lines.push(`## ${file.path}`, "", file.content, "");
  }

  // 5. Group Chat / Subagent Context — ABSOLUTELY LAST (most frequent: per-conversation).
  // Placing GroupChat last ensures the entire prompt above (workspace files, deployment config,
  // tools, model aliases, skills, workspace notes, MEMORY.md) is KV-cached between
  // conversation switches — even when daily notes or other sections update.
  if (extraSystemPrompt) {
    const contextHeader =
      promptMode === "minimal" ? "## Subagent Context" : "## Group Chat Context";
    lines.push(contextHeader, extraSystemPrompt, "");
  }

  return lines.filter(Boolean).join("\n");
}

export function buildRuntimeLine(runtimeInfo?: {
  agentId?: string;
  host?: string;
  os?: string;
  arch?: string;
  node?: string;
  model?: string;
  defaultModel?: string;
  shell?: string;
  repoRoot?: string;
}): string {
  // Stable fields only — channel, capabilities, thinking, agentId, model are emitted
  // separately in buildRuntimeDynamicLine so the stable prefix can be KV-cached by Anthropic
  // across sessions AND across channels (multi-channel deployments).
  return `Runtime: ${[
    runtimeInfo?.host ? `host=${runtimeInfo.host}` : "",
    runtimeInfo?.repoRoot ? `repo=${runtimeInfo.repoRoot}` : "",
    runtimeInfo?.os
      ? `os=${runtimeInfo.os}${runtimeInfo?.arch ? ` (${runtimeInfo.arch})` : ""}`
      : runtimeInfo?.arch
        ? `arch=${runtimeInfo.arch}`
        : "",
    runtimeInfo?.node ? `node=${runtimeInfo.node}` : "",
    runtimeInfo?.shell ? `shell=${runtimeInfo.shell}` : "",
  ]
    .filter(Boolean)
    .join(" | ")}`;
}

/**
 * Builds a line containing per-session and per-conversation dynamic runtime fields.
 * Kept separate from buildRuntimeLine so the stable content above (including Reasoning)
 * can be reused by Anthropic's KV prefix cache across sessions AND channels.
 *
 * Fields emitted here change per session (model, agentId) or per conversation (channel,
 * capabilities, thinking). Moving them to the end of the prompt means the large stable
 * prefix (boilerplate + workspace files, ~28k chars) is cached even when:
 *   - The user switches between channels (WhatsApp → Telegram → iMessage)
 *   - A different model is selected
 *   - The reasoning mode changes
 *
 * Returns an empty string when no dynamic fields are present.
 */
export function buildRuntimeDynamicLine(
  runtimeInfo?: {
    agentId?: string;
    model?: string;
    defaultModel?: string;
    channel?: string;
    capabilities?: string[];
  },
  defaultThinkLevel?: ThinkLevel,
  reasoningLevel?: ReasoningLevel,
): string {
  const parts = [
    // Per-conversation: channel and capabilities change across messaging platforms
    runtimeInfo?.channel ? `channel=${runtimeInfo.channel}` : "",
    runtimeInfo?.channel
      ? `capabilities=${runtimeInfo?.capabilities?.length ? runtimeInfo.capabilities.join(",") : "none"}`
      : "",
    // Per-session: reasoning level (only emit when non-default to save tokens)
    reasoningLevel && reasoningLevel !== "off" ? `reasoning=${reasoningLevel}` : "",
    // Per-session: thinking level, model, agentId, defaultModel
    defaultThinkLevel && defaultThinkLevel !== "off" ? `thinking=${defaultThinkLevel}` : "",
    runtimeInfo?.agentId ? `agent=${runtimeInfo.agentId}` : "",
    runtimeInfo?.model ? `model=${runtimeInfo.model}` : "",
    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" | ") : "";
}
