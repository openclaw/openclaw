/**
 * Tool display metadata registry.
 *
 * Agent UIs use this config to map tool names/actions to stable titles,
 * icons, and detail keys without embedding presentation data in tool handlers.
 */
import type { ToolDisplaySpec as ToolDisplaySpecBase } from "./tool-display-common.js";

type ToolDisplaySpec = ToolDisplaySpecBase & {
  icon: string;
};

export type ToolDisplayConfig = {
  version: number;
  fallback: ToolDisplaySpec;
  tools: Record<string, ToolDisplaySpec>;
};

function displayTool(icon: string, title: string, detailKeys?: string[]): ToolDisplaySpec {
  return detailKeys === undefined ? { icon, title } : { icon, title, detailKeys };
}

/** Tool identity readers never load the per-action detail and progress specifications. */
export const TOOL_DISPLAY_BASE = {
  version: 1,
  fallback: {
    icon: "puzzle",
    detailKeys: [
      "command",
      "path",
      "url",
      "targetUrl",
      "targetId",
      "ref",
      "element",
      "node",
      "nodeId",
      "id",
      "requestId",
      "to",
      "channelId",
      "guildId",
      "userId",
      "name",
      "query",
      "pattern",
      "messageId",
    ],
  },
  tools: {
    bash: displayTool("squareTerminal", "Bash", ["command"]),
    computer: displayTool("monitor", "Computer", [
      "action",
      "coordinate",
      "text",
      "node",
      "nodeId",
      "screenIndex",
    ]),
    mobile_ui: displayTool("monitorSmartphone", "Mobile UI", [
      "action",
      "mobileAction",
      "snapshotId",
      "node",
      "nodeId",
    ]),
    screen: displayTool("monitor", "Screen", ["action", "sessionKey", "dock"]),
    theme: displayTool("palette", "Theme", ["action", "id", "mode"]),
    terminal: displayTool("squareTerminal", "Terminal", ["action", "sessionId", "command", "cwd"]),
    portal: displayTool("globe", "Portal", ["action", "port", "id", "title", "path"]),
    process: displayTool("squareTerminal", "Process", ["sessionId"]),
    gateway_process: displayTool("squareTerminal", "Background Shell", ["action", "sessionId"]),
    read: displayTool("fileText", "Read", ["path"]),
    write: displayTool("edit", "Write", ["path"]),
    edit: displayTool("penLine", "Edit", ["path"]),
    personal_instructions: displayTool("penLine", "Personal Instructions", ["action", "agentId"]),
    presence: displayTool("radio", "Presence"),
    attach: displayTool("paperclip", "Attach", ["path", "url", "fileName"]),
    api: displayTool("globe", "API", ["url", "endpoint", "path", "method", "name"]),
    browser: displayTool("globe", "Browser"),
    canvas: displayTool("image", "Canvas"),
    dashboard: displayTool("layoutDashboard", "Dashboard", ["action", "tabId", "name", "title"]),
    nodes: displayTool("monitorSmartphone", "Nodes"),
    cron: displayTool("calendarClock", "Cron"),
    get_goal: displayTool("target", "Get Goal", []),
    create_goal: displayTool("target", "Create Goal", ["objective", "token_budget"]),
    update_goal: displayTool("target", "Update Goal", ["status"]),
    progress_card: displayTool("listChecks", "Progress Card"),
    ask_user: displayTool("shieldQuestion", "Ask User", ["questions.0.question"]),
    secrets: displayTool("key", "Secrets", ["action", "name", "kind"]),
    suggest_task: displayTool("spark", "Suggest Task", ["title", "tldr", "cwd"]),
    dismiss_task: displayTool("trash", "Dismiss Task", ["task_id", "reason"]),
    skill_workshop: displayTool("wrench", "Skill Workshop", ["action", "name", "proposal_id"]),
    skill_library: displayTool("wrench", "Skill Library", ["action", "name", "skill_id"]),
    openclaw: displayTool("claw", "OpenClaw", ["action", "path", "model"]),
    gateway: displayTool("plug", "Gateway", ["action", "path"]),
    plugins: displayTool("puzzle", "Plugins", ["action", "pluginId", "packageName", "query"]),
    exec: displayTool("squareTerminal", "Exec", ["command"]),
    tool_call: displayTool("wrench", "Tool Call", []),
    dispatch_action: displayTool("wrench", "Tool Call", []),
    tool_call_update: displayTool("wrench", "Tool Call", []),
    session_status: displayTool("barChart", "Session Status", ["sessionKey", "model"]),
    github_publish: displayTool("github", "GitHub Publish", ["title"]),
    github_identity_status: displayTool("settings", "GitHub Identity Status", []),
    session_project: displayTool("layers", "Session Project", ["action", "projectId"]),
    sessions: displayTool("layers", "Session Settings"),
    sessions_create: displayTool("layers", "New session", ["label", "agentId", "cwd", "group"]),
    sessions_list: displayTool("layers", "Sessions", [
      "kinds",
      "label",
      "agentId",
      "search",
      "limit",
      "activeMinutes",
      "includeDerivedTitles",
      "includeLastMessage",
      "messageLimit",
    ]),
    conversations_list: displayTool("messageSquare", "Conversations", ["channel", "limit"]),
    conversations_send: displayTool("send", "Conversation Send", ["conversationRef"]),
    conversations_turn: displayTool("arrowLeftRight", "Conversation Turn", [
      "conversationRef",
      "timeoutSeconds",
    ]),
    knowledge_record: {
      ...displayTool("fileText", "Knowledge Record"),
      progress: { label: "Read knowledge record", detailKeys: [] },
    },
    knowledge_remember: {
      ...displayTool("brain", "Knowledge Remember"),
      progress: { label: "Remember knowledge", detailKeys: [] },
    },
    sessions_send: {
      ...displayTool("send", "Session Send", ["label", "sessionKey", "agentId", "timeoutSeconds"]),
      progress: { label: "Send to session", detailKeys: ["label"], referenceKey: "sessionKey" },
    },
    sessions_history: {
      ...displayTool("fileText", "Session History", ["sessionKey", "limit", "includeTools"]),
      progress: { label: "Read session history", detailKeys: [], referenceKey: "sessionKey" },
    },
    sessions_search: displayTool("search", "Session Search", ["query", "sessionKey", "limit"]),
    transcripts: displayTool("mic", "Transcripts"),
    sessions_spawn: {
      ...displayTool("bot", "Sub-agent", [
        "label",
        "taskName",
        "agentId",
        "model",
        "thinking",
        "runTimeoutSeconds",
        "cleanup",
      ]),
      progress: { label: "Start subagent", detailKeys: ["label"] },
    },
    agents_wait: displayTool("clock", "Wait for Agents", ["ids", "timeoutSeconds"]),
    structured_output: displayTool("fileText", "Structured Output", ["result"]),
    subagents: displayTool("bot", "Subagents"),
    agents_list: displayTool("users", "Agents", []),
    memory_search: displayTool("search", "Memory Search", ["query"]),
    memory_get: displayTool("brain", "Memory Get", ["path", "from", "lines"]),
    skills_search: displayTool("search", "Skill Search", ["query"]),
    skills_read: displayTool("fileText", "Skill Read", ["name"]),
    web_search: displayTool("search", "Web Search", ["query", "count"]),
    web_fetch: displayTool("globe", "Web Fetch", ["url", "extractMode", "maxChars"]),
    code_execution: displayTool("braces", "Code Execution", ["task"]),
    decision_evaluate: displayTool("shieldCheck", "Decision Evaluation", []),
    /** Display metadata for the transport-neutral message action surface. */
    message: displayTool("mail", "Message"),
    apply_patch: displayTool("fileDiff", "Apply Patch", []),
    // Historical transcripts retain the old name. This display-only entry
    // preserves their presentation without restoring a runtime tool alias.
    image: displayTool("image", "Image", ["path", "paths", "url", "urls", "prompt", "model"]),
    view_image: displayTool("image", "View Image", [
      "path",
      "paths",
      "url",
      "urls",
      "prompt",
      "model",
    ]),
    image_generate: displayTool("image", "Image Generation"),
    music_generate: displayTool("music", "Music Generation"),
    video_generate: displayTool("play", "Video Generation"),
    pdf: displayTool("fileText", "PDF", [
      "path",
      "paths",
      "url",
      "urls",
      "prompt",
      "pageRange",
      "model",
    ]),
    sessions_yield: displayTool("pause", "Yield"),
    tts: displayTool("audioLines", "TTS", ["text", "channel"]),
  },
} satisfies ToolDisplayConfig;
