/**
 * Tool display metadata registry.
 *
 * Agent UIs use this config to map tool names/actions to stable titles,
 * icons, and detail keys without embedding presentation data in tool handlers.
 */
import type { ToolDisplaySpec as ToolDisplaySpecBase } from "./tool-display-common.js";
import { MESSAGE_TOOL_DISPLAY_SPEC } from "./tool-display-message-config.js";

type ToolDisplaySpec = ToolDisplaySpecBase & {
  icon: string;
};

type ToolDisplayConfig = {
  version: number;
  fallback: ToolDisplaySpec;
  tools: Record<string, ToolDisplaySpec>;
};

function displayTool(icon: string, title: string, detailKeys?: string[]): ToolDisplaySpec {
  return detailKeys === undefined ? { icon, title } : { icon, title, detailKeys };
}

function displayAction(label: string, detailKeys?: string[]) {
  return detailKeys === undefined ? { label } : { label, detailKeys };
}

function mediaGenerationTool(icon: string, title: string, detailKeys: string[]): ToolDisplaySpec {
  return {
    icon,
    title,
    actions: {
      generate: displayAction("generate", detailKeys),
      list: displayAction("list", ["provider", "model"]),
    },
  };
}

/** Static display metadata for known tools plus fallback detail-key selection. */
export const TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
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
    personal_instructions: {
      icon: "penLine",
      title: "Personal Instructions",
      detailKeys: ["action", "agentId"],
      actions: {
        get: displayAction("read", ["agentId"]),
        set: displayAction("save", ["agentId"]),
      },
    },
    presence: displayTool("radio", "Presence"),
    attach: displayTool("paperclip", "Attach", ["path", "url", "fileName"]),
    api: displayTool("globe", "API", ["url", "endpoint", "path", "method", "name"]),
    browser: {
      icon: "globe",
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
      icon: "image",
      title: "Canvas",
      actions: {
        present: displayAction("present", ["target", "node", "nodeId"]),
        hide: displayAction("hide", ["node", "nodeId"]),
        navigate: displayAction("navigate", ["url", "node", "nodeId"]),
      },
    },
    dashboard: displayTool("layoutDashboard", "Dashboard", ["action", "tabId", "name", "title"]),
    nodes: {
      icon: "monitorSmartphone",
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
      icon: "calendarClock",
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
    get_goal: displayTool("target", "Get Goal", []),
    create_goal: displayTool("target", "Create Goal", ["objective", "token_budget"]),
    update_goal: displayTool("target", "Update Goal", ["status"]),
    progress_card: displayTool("listChecks", "Progress Card"),
    ask_user: displayTool("shieldQuestion", "Ask User", ["questions.0.question"]),
    secrets: displayTool("key", "Secrets", ["action", "name", "kind"]),
    suggest_task: displayTool("spark", "Suggest Task", ["title", "tldr", "cwd"]),
    dismiss_task: displayTool("trash", "Dismiss Task", ["task_id", "reason"]),
    skill_workshop: displayTool("wrench", "Skill Workshop", ["action", "name", "proposal_id"]),
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
    sessions: {
      icon: "layers",
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
    sessions_send: displayTool("send", "Session Send", [
      "label",
      "sessionKey",
      "agentId",
      "timeoutSeconds",
    ]),
    sessions_history: displayTool("fileText", "Session History", [
      "sessionKey",
      "limit",
      "includeTools",
    ]),
    sessions_search: displayTool("search", "Session Search", ["query", "sessionKey", "limit"]),
    transcripts: {
      icon: "mic",
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
    sessions_spawn: displayTool("bot", "Sub-agent", [
      "label",
      "taskName",
      "agentId",
      "model",
      "thinking",
      "runTimeoutSeconds",
      "cleanup",
    ]),
    agents_wait: displayTool("clock", "Wait for Agents", ["ids", "timeoutSeconds"]),
    structured_output: displayTool("fileText", "Structured Output", ["result"]),
    subagents: {
      icon: "users",
      title: "Subagents",
      actions: {
        list: displayAction("list", ["recentMinutes"]),
        kill: displayAction("kill", ["target"]),
        steer: displayAction("steer", ["target"]),
      },
    },
    agents_list: displayTool("users", "Agents", []),
    memory_search: displayTool("search", "Memory Search", ["query"]),
    memory_get: displayTool("brain", "Memory Get", ["path", "from", "lines"]),
    skills_search: displayTool("search", "Skill Search", ["query"]),
    skills_read: displayTool("fileText", "Skill Read", ["name"]),
    web_search: displayTool("search", "Web Search", ["query", "count"]),
    web_fetch: displayTool("globe", "Web Fetch", ["url", "extractMode", "maxChars"]),
    code_execution: displayTool("braces", "Code Execution", ["task"]),
    decision_evaluate: displayTool("shieldCheck", "Decision Evaluation", []),
    message: MESSAGE_TOOL_DISPLAY_SPEC,
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
    image_generate: mediaGenerationTool("image", "Image Generation", [
      "prompt",
      "model",
      "count",
      "resolution",
      "aspectRatio",
    ]),
    music_generate: mediaGenerationTool("music", "Music Generation", [
      "prompt",
      "model",
      "durationSeconds",
      "format",
      "instrumental",
    ]),
    video_generate: mediaGenerationTool("play", "Video Generation", [
      "prompt",
      "model",
      "durationSeconds",
      "resolution",
      "aspectRatio",
      "audio",
      "watermark",
    ]),
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
};
