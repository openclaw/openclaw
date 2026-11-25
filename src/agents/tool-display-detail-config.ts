import { TOOL_DISPLAY_BASE, type ToolDisplayConfig } from "./tool-display-config.js";

function displayAction(label: string, detailKeys?: string[]) {
  return detailKeys === undefined ? { label } : { label, detailKeys };
}

function mediaActions(detailKeys: string[]) {
  return {
    generate: displayAction("generate", detailKeys),
    list: displayAction("list", ["provider", "model"]),
  };
}

const actionSpecs = {
  personal_instructions: {
    get: displayAction("read", ["agentId"]),
    set: displayAction("save", ["agentId"]),
  },
  browser: {
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
  canvas: {
    present: displayAction("present", ["target", "node", "nodeId"]),
    hide: displayAction("hide", ["node", "nodeId"]),
    navigate: displayAction("navigate", ["url", "node", "nodeId"]),
  },
  nodes: {
    status: { ...displayAction("status"), progress: { label: "List nodes", detailKeys: [] } },
    invoke: {
      label: "invoke",
      detailKeys: ["invokeCommand", "node", "nodeId"],
      progress: {
        label: "Invoke node operation",
        detailKeys: ["invokeCommand", "node", "nodeId"],
      },
    },
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
  cron: {
    status: displayAction("status"),
    list: displayAction("list"),
    add: displayAction("add", ["job.name", "job.id", "job.schedule", "job.cron"]),
    update: displayAction("update", ["id"]),
    remove: displayAction("remove", ["id"]),
    run: displayAction("run", ["id"]),
    runs: displayAction("runs", ["id"]),
    wake: displayAction("wake", ["text", "mode"]),
  },
  sessions: {
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
  transcripts: {
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
  subagents: {
    list: displayAction("list", ["recentMinutes"]),
    kill: {
      ...displayAction("kill", ["target"]),
      progress: { label: "Stop subagent", detailKeys: ["target"], referenceKey: "target" },
    },
    steer: {
      ...displayAction("steer", ["target"]),
      progress: { label: "Send to subagent", detailKeys: ["target"], referenceKey: "target" },
    },
  },
  message: {
    send: displayAction("send", ["provider", "to", "media", "replyTo", "threadId"]),
    poll: displayAction("poll", ["provider", "to", "pollQuestion"]),
    react: displayAction("react", ["provider", "to", "messageId", "emoji", "remove"]),
    reactions: displayAction("reactions", ["provider", "to", "messageId", "limit"]),
    read: displayAction("read", ["provider", "to", "limit"]),
    edit: displayAction("edit", ["provider", "to", "messageId"]),
    delete: displayAction("delete", ["provider", "to", "messageId"]),
    pin: displayAction("pin", ["provider", "to", "messageId"]),
    unpin: displayAction("unpin", ["provider", "to", "messageId"]),
    "list-pins": displayAction("list pins", ["provider", "to"]),
    permissions: displayAction("permissions", ["provider", "channelId", "to"]),
    "thread-create": displayAction("thread create", ["provider", "channelId", "threadName"]),
    "thread-list": displayAction("thread list", ["provider", "guildId", "channelId"]),
    "thread-reply": displayAction("thread reply", ["provider", "channelId", "messageId"]),
    search: displayAction("search", ["provider", "guildId", "query"]),
    sticker: displayAction("sticker", ["provider", "to", "stickerId"]),
    "member-info": displayAction("member", ["provider", "guildId", "userId"]),
    "role-info": displayAction("roles", ["provider", "guildId"]),
    "emoji-list": displayAction("emoji list", ["provider", "guildId"]),
    "emoji-upload": displayAction("emoji upload", ["provider", "guildId", "emojiName"]),
    "sticker-upload": displayAction("sticker upload", ["provider", "guildId", "stickerName"]),
    "role-add": displayAction("role add", ["provider", "guildId", "userId", "roleId"]),
    "role-remove": displayAction("role remove", ["provider", "guildId", "userId", "roleId"]),
    "channel-info": displayAction("channel", ["provider", "channelId"]),
    "channel-list": displayAction("channels", ["provider", "guildId"]),
    "voice-status": displayAction("voice", ["provider", "guildId", "userId"]),
    "event-list": displayAction("events", ["provider", "guildId"]),
    "event-create": displayAction("event create", ["provider", "guildId", "eventName"]),
    timeout: displayAction("timeout", ["provider", "guildId", "userId"]),
    kick: displayAction("kick", ["provider", "guildId", "userId"]),
    ban: displayAction("ban", ["provider", "guildId", "userId"]),
  },
  image_generate: mediaActions(["prompt", "model", "count", "resolution", "aspectRatio"]),
  music_generate: mediaActions(["prompt", "model", "durationSeconds", "format", "instrumental"]),
  video_generate: mediaActions([
    "prompt",
    "model",
    "durationSeconds",
    "resolution",
    "aspectRatio",
    "audio",
    "watermark",
  ]),
} satisfies Partial<
  Record<
    keyof typeof TOOL_DISPLAY_BASE.tools,
    NonNullable<ToolDisplayConfig["fallback"]["actions"]>
  >
>;

// Only the detail renderers and client catalog generation need per-action metadata.
const tools: ToolDisplayConfig["tools"] = { ...TOOL_DISPLAY_BASE.tools };
for (const [name, actions] of Object.entries(actionSpecs)) {
  tools[name] = { ...tools[name]!, actions };
}

export const TOOL_DISPLAY_CONFIG: ToolDisplayConfig = { ...TOOL_DISPLAY_BASE, tools };
