import SHARED_TOOL_DISPLAY_JSON from "../../apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json" with { type: "json" };
import { redactToolDetail } from "../logging/redact.js";
import { shortenHomeInString } from "../utils.js";
import { defaultTitle, formatToolDetailText, formatDetailKey, normalizeToolName, resolveActionArg, resolveToolVerbAndDetail, } from "./tool-display-common.js";
import TOOL_DISPLAY_OVERRIDES_JSON from "./tool-display-overrides.json" with { type: "json" };
const SHARED_TOOL_DISPLAY_CONFIG = SHARED_TOOL_DISPLAY_JSON;
const TOOL_DISPLAY_OVERRIDES = TOOL_DISPLAY_OVERRIDES_JSON;
const FALLBACK = TOOL_DISPLAY_OVERRIDES.fallback ??
    SHARED_TOOL_DISPLAY_CONFIG.fallback ?? { emoji: "🧩" };
const TOOL_MAP = Object.assign({}, SHARED_TOOL_DISPLAY_CONFIG.tools, TOOL_DISPLAY_OVERRIDES.tools);
const DETAIL_LABEL_OVERRIDES = {
    agentId: "agent",
    sessionKey: "session",
    targetId: "target",
    targetUrl: "url",
    nodeId: "node",
    requestId: "request",
    messageId: "message",
    threadId: "thread",
    channelId: "channel",
    guildId: "guild",
    userId: "user",
    runTimeoutSeconds: "timeout",
    timeoutSeconds: "timeout",
    includeTools: "tools",
    pollQuestion: "poll",
    maxChars: "max chars",
};
const MAX_DETAIL_ENTRIES = 8;
export function resolveToolDisplay(params) {
    const name = normalizeToolName(params.name);
    const key = name.toLowerCase();
    const spec = TOOL_MAP[key];
    const emoji = spec?.emoji ?? FALLBACK.emoji ?? "🧩";
    const title = spec?.title ?? defaultTitle(name);
    const label = spec?.label ?? title;
    const action = resolveActionArg(params.args);
    let { verb, detail } = resolveToolVerbAndDetail({
        toolKey: key,
        args: params.args,
        meta: params.meta,
        action,
        spec,
        fallbackDetailKeys: FALLBACK.detailKeys,
        detailMode: "summary",
        detailMaxEntries: MAX_DETAIL_ENTRIES,
        detailFormatKey: (raw) => formatDetailKey(raw, DETAIL_LABEL_OVERRIDES),
    });
    if (detail) {
        detail = shortenHomeInString(detail);
    }
    return {
        name,
        emoji,
        title,
        label,
        verb,
        detail,
    };
}
export function formatToolDetail(display) {
    const detailRaw = display.detail ? redactToolDetail(display.detail) : undefined;
    return formatToolDetailText(detailRaw, { prefixWithWith: true });
}
export function formatToolSummary(display) {
    const detail = formatToolDetail(display);
    return detail
        ? `${display.emoji} ${display.label}: ${detail}`
        : `${display.emoji} ${display.label}`;
}
