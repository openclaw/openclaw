/**
 * Tool display metadata registry.
 *
 * Agent UIs use this config to map tool names/actions to stable titles,
 * icons, and detail keys without embedding presentation data in tool handlers.
 */
import type { ToolDisplaySpec as ToolDisplaySpecBase } from "./tool-display-common.js";
import { MESSAGE_TOOL_DISPLAY_SPEC } from "./tool-display-message-config.js";

type ToolDisplaySpec = ToolDisplaySpecBase & {
  emoji?: string;
};

type ToolDisplayConfig = {
  version: number;
  fallback: ToolDisplaySpec;
  tools: Record<string, ToolDisplaySpec>;
};

function displayTool(emoji: string, title: string, detailKeys?: string[]): ToolDisplaySpec {
  return detailKeys === undefined ? { emoji, title } : { emoji, title, detailKeys };
}

function displayAction(label: string, detailKeys?: string[]) {
  return detailKeys === undefined ? { label } : { label, detailKeys };
}

/** Static display metadata for known tools plus fallback detail-key selection. */
export const TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
  version: 1,
  fallback: {
    emoji: "🧩",
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
    bash: displayTool("🛠️", "Bash", ["command"]),
    computer: displayTool("🖱️", "Computer", [
      "action",
      "coordinate",
      "text",
      "node",
      "nodeId",
      "screenIndex",
    ]),
    mobile_ui: displayTool("📱", "Mobile UI", [
      "action",
      "mobileAction",
      "snapshotId",
      "node",
      "nodeId",
    ]),
    screen: displayTool("🖥️", "Screen", ["action", "sessionKey", "dock"]),
    theme: displayTool("🎨", "Theme", ["action", "id", "mode"]),
    terminal: displayTool("⌨️", "Terminal", ["action", "sessionId", "command", "cwd"]),
    portal: displayTool("🌐", "Portal", ["action", "port", "id", "title", "path"]),
    process: displayTool("🧰", "Process", ["sessionId"]),
    gateway_process: displayTool("🧰", "Background Shell", ["action", "sessionId"]),
    read: displayTool("📖", "Read", ["path"]),
    write: displayTool("✍️", "Write", ["path"]),
    edit: displayTool("📝", "Edit", ["path"]),
    personal_instructions: {
      emoji: "📝",
      title: "Personal Instructions",
      detailKeys: ["action", "agentId"],
      actions: {
        get: displayAction("read", ["agentId"]),
        set: displayAction("save", ["agentId"]),
      },
    },
    presence: displayTool("🧩", "Presence"),
    attach: displayTool("📎", "Attach", ["path", "url", "fileName"]),
    api: displayTool("🌐", "API", ["url", "endpoint", "path", "method", "name"]),
    browser: {
      emoji: "🌐",
      title: "Browser",
      actions: {
        status: displayAction("status"),
        start: displayAction("start"),
        stop: displayAction("stop"),
        tabs: displayAction("tabs"),
        open: displayAction("open", ["targetUrl"]),
        focus: displayAction("focus", ["targetId"]),
        close: displayAction("close", ["targetId"]),
        snapshot: displayAction("snapshot", ["targetUrl", "targetId", "ref", "element", "format"]),
        screenshot: displayAction("screenshot", ["targetUrl", "targetId", "ref", "element"]),
        navigate: displayAction("navigate", ["targetUrl", "targetId"]),
        console: displayAction("console", ["level", "targetId"]),
        pdf: displayAction("pdf", ["targetId"]),
        upload: displayAction("upload", ["paths", "ref", "inputRef", "element", "targetId"]),
        dialog: displayAction("dialog", ["accept", "promptText", "targetId"]),
        act: displayAction("act", [
          "request.kind",
          "request.ref",
          "request.selector",
          "request.text",
          "request.value",
        ]),
      },
    },
    canvas: {
      emoji: "🖼️",
      title: "Canvas",
      actions: {
        present: displayAction("present", ["target", "node", "nodeId"]),
        hide: displayAction("hide", ["node", "nodeId"]),
        navigate: displayAction("navigate", ["url", "node", "nodeId"]),
      },
    },
    dashboard: displayTool("📋", "Dashboard", ["action", "tabId", "name", "title"]),
    nodes: {
      emoji: "📱",
      title: "Nodes",
      actions: {
        status: displayAction("status"),
        describe: displayAction("describe", ["node", "nodeId"]),
        pending: displayAction("pending"),
        approve: displayAction("approve", ["requestId"]),
        reject: displayAction("reject", ["requestId"]),
        notify: displayAction("notify", ["node", "nodeId", "title", "body"]),
        camera_snap: displayAction("camera snap", ["node", "nodeId", "facing", "deviceId"]),
        camera_list: displayAction("camera list", ["node", "nodeId"]),
        camera_clip: displayAction("camera clip", [
          "node",
          "nodeId",
          "facing",
          "duration",
          "durationMs",
        ]),
        camera_ptz: displayAction("camera PTZ", ["ptzOperation", "node", "nodeId", "deviceId"]),
        screen_record: displayAction("screen record", [
          "node",
          "nodeId",
          "duration",
          "durationMs",
          "fps",
          "screenIndex",
        ]),
        screen_snapshot: displayAction("screen snapshot", [
          "node",
          "nodeId",
          "screenIndex",
          "maxWidth",
        ]),
      },
    },
    cron: {
      emoji: "⏰",
      title: "Cron",
      actions: {
        status: displayAction("status"),
        list: displayAction("list"),
        add: displayAction("add", ["job.name", "job.id", "job.schedule", "job.cron"]),
        update: displayAction("update", ["id"]),
        remove: displayAction("remove", ["id"]),
        run: displayAction("run", ["id"]),
        runs: displayAction("runs", ["id"]),
        wake: displayAction("wake", ["text", "mode"]),
      },
    },
    get_goal: displayTool("🎯", "Get Goal", []),
    create_goal: displayTool("🎯", "Create Goal", ["objective", "token_budget"]),
    update_goal: displayTool("🎯", "Update Goal", ["status"]),
    progress_card: displayTool("🗺️", "Progress Card"),
    ask_user: displayTool("❓", "Ask User", ["questions.0.question"]),
    secrets: displayTool("🔑", "Secrets", ["action", "name", "kind"]),
    suggest_task: displayTool("✨", "Suggest Task", ["title", "tldr", "cwd"]),
    dismiss_task: displayTool("🗑️", "Dismiss Task", ["task_id", "reason"]),
    skill_workshop: displayTool("🧰", "Skill Workshop", ["action", "name", "proposal_id"]),
    openclaw: displayTool("🦀", "OpenClaw", ["action", "path", "model"]),
    gateway: displayTool("🔌", "Gateway", ["action", "path"]),
    plugins: displayTool("🧩", "Plugins", ["action", "pluginId", "packageName", "query"]),
    exec: displayTool("🛠️", "Exec", ["command"]),
    tool_call: displayTool("🧰", "Tool Call", []),
    tool_call_update: displayTool("🧰", "Tool Call", []),
    session_status: displayTool("📊", "Session Status", ["sessionKey", "model"]),
    github_publish: displayTool("🔀", "GitHub Publish", ["title"]),
    github_identity_status: displayTool("🔐", "GitHub Identity Status", []),
    sessions: {
      emoji: "🗂️",
      title: "Session Settings",
      actions: {
        patch: displayAction("update", [
          "sessionKey",
          "label",
          "pinned",
          "archived",
          "model",
          "thinkingLevel",
        ]),
        group_list: displayAction("groups"),
        group_set: displayAction("set groups", ["names"]),
        group_rename: displayAction("rename group", ["name", "to"]),
        group_delete: displayAction("delete group", ["name"]),
      },
    },
    sessions_create: displayTool("🗂️", "Create Session", ["label", "agentId", "cwd", "group"]),
    sessions_list: displayTool("🗂️", "Sessions", [
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
    conversations_list: displayTool("💬", "Conversations", ["channel", "limit"]),
    conversations_send: displayTool("📨", "Conversation Send", ["conversationRef"]),
    conversations_turn: displayTool("↔️", "Conversation Turn", [
      "conversationRef",
      "timeoutSeconds",
    ]),
    sessions_send: displayTool("📨", "Session Send", [
      "label",
      "sessionKey",
      "agentId",
      "timeoutSeconds",
    ]),
    sessions_history: displayTool("🧾", "Session History", ["sessionKey", "limit", "includeTools"]),
    sessions_search: displayTool("🔎", "Session Search", ["query", "sessionKey", "limit"]),
    transcripts: {
      emoji: "🎙️",
      title: "Transcripts",
      actions: {
        start: displayAction("start", [
          "sessionId",
          "title",
          "providerId",
          "accountId",
          "guildId",
          "channelId",
          "meetingUrl",
        ]),
        stop: displayAction("stop", ["sessionId"]),
        status: displayAction("status"),
        import: displayAction("import", [
          "sessionId",
          "title",
          "providerId",
          "meetingUrl",
          "speakerLabel",
        ]),
        summarize: displayAction("summarize", ["sessionId"]),
      },
    },
    sessions_spawn: displayTool("🧑‍🔧", "Sub-agent", [
      "label",
      "taskName",
      "agentId",
      "model",
      "thinking",
      "runTimeoutSeconds",
      "cleanup",
    ]),
    agents_wait: displayTool("⏳", "Wait for Agents", ["ids", "timeoutSeconds"]),
    structured_output: displayTool("🧾", "Structured Output", ["result"]),
    subagents: {
      emoji: "🤖",
      title: "Subagents",
      actions: {
        list: displayAction("list", ["recentMinutes"]),
        kill: displayAction("kill", ["target"]),
        steer: displayAction("steer", ["target"]),
      },
    },
    agents_list: displayTool("🧭", "Agents", []),
    memory_search: displayTool("🧠", "Memory Search", ["query"]),
    memory_get: displayTool("📓", "Memory Get", ["path", "from", "lines"]),
    skills_search: displayTool("🔍", "Skill Search", ["query"]),
    skills_read: displayTool("📖", "Skill Read", ["name"]),
    web_search: displayTool("🔎", "Web Search", ["query", "count"]),
    web_fetch: displayTool("📄", "Web Fetch", ["url", "extractMode", "maxChars"]),
    code_execution: displayTool("🧮", "Code Execution", ["task"]),
    decision_evaluate: displayTool("⚖️", "Decision Evaluation", []),
    message: MESSAGE_TOOL_DISPLAY_SPEC,
    apply_patch: displayTool("🩹", "Apply Patch", []),
    // Historical transcripts retain the old name. This display-only entry
    // preserves their presentation without restoring a runtime tool alias.
    image: displayTool("🖼️", "Image", ["path", "paths", "url", "urls", "prompt", "model"]),
    view_image: displayTool("🖼️", "View Image", [
      "path",
      "paths",
      "url",
      "urls",
      "prompt",
      "model",
    ]),
    image_generate: {
      emoji: "🎨",
      title: "Image Generation",
      actions: {
        generate: displayAction("generate", [
          "prompt",
          "model",
          "count",
          "resolution",
          "aspectRatio",
        ]),
        list: displayAction("list", ["provider", "model"]),
      },
    },
    music_generate: {
      emoji: "🎵",
      title: "Music Generation",
      actions: {
        generate: displayAction("generate", [
          "prompt",
          "model",
          "durationSeconds",
          "format",
          "instrumental",
        ]),
        list: displayAction("list", ["provider", "model"]),
      },
    },
    video_generate: {
      emoji: "🎬",
      title: "Video Generation",
      actions: {
        generate: displayAction("generate", [
          "prompt",
          "model",
          "durationSeconds",
          "resolution",
          "aspectRatio",
          "audio",
          "watermark",
        ]),
        list: displayAction("list", ["provider", "model"]),
      },
    },
    pdf: displayTool("📑", "PDF", ["path", "paths", "url", "urls", "prompt", "pageRange", "model"]),
    sessions_yield: displayTool("⏸️", "Yield"),
    tts: displayTool("🔊", "TTS", ["text", "channel"]),
  },
};
