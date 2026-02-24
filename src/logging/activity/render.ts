import { truncateUtf16Safe } from "../../utils.js";
import type { ActivityMeta, ActivityRenderOptions } from "./types.js";

const PREVIEW_LIMIT_NORMAL = 120;
const PREVIEW_LIMIT_FULL = 240;

function formatDuration(durationMs?: number): string {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return "";
  }
  return `${Math.round(durationMs)}ms`;
}

function formatPreview(value: string, mode: ActivityRenderOptions["mode"]): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  const limit = mode === "full" ? PREVIEW_LIMIT_FULL : PREVIEW_LIMIT_NORMAL;
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, limit)}…`;
}

function compactExtra(activity: ActivityMeta): string {
  if (!activity.extra) {
    return "";
  }
  const keys = Object.keys(activity.extra);
  if (keys.length === 0) {
    return "";
  }
  return keys
    .slice(0, 6)
    .map((key) => {
      const raw = activity.extra?.[key];
      const value = String(raw);
      if (typeof raw === "string" && /\s/.test(raw)) {
        return `${key}="${value.replace(/"/g, '\\"')}"`;
      }
      return `${key}=${value}`;
    })
    .join(" ");
}

function renderStatus(activity: ActivityMeta): string {
  if (!activity.status) {
    return "";
  }
  if (activity.status === "error") {
    return "error";
  }
  if (activity.status === "ok") {
    return "ok";
  }
  if (activity.status === "blocked") {
    return "blocked";
  }
  if (activity.status === "skip") {
    return "skip";
  }
  if (activity.status === "queued") {
    return "queued";
  }
  if (activity.status === "dequeued") {
    return "dequeued";
  }
  if (activity.status === "done") {
    return "done";
  }
  return activity.status;
}

function renderKind(activity: ActivityMeta): string {
  if (activity.channel) {
    return `${activity.channel}/${activity.kind}`;
  }
  return activity.kind;
}

export function renderActivityLine(activity: ActivityMeta, opts: ActivityRenderOptions): string {
  const parts: string[] = [];
  if (opts.time) {
    parts.push(opts.time);
  }

  parts.push(renderKind(activity));
  parts.push(activity.summary);

  const status = renderStatus(activity);
  if (status) {
    parts.push(`status=${status}`);
  }

  const duration = formatDuration(activity.durationMs);
  if (duration) {
    parts.push(`duration=${duration}`);
  }

  if (typeof activity.chars === "number") {
    parts.push(`chars=${activity.chars}`);
  }

  const extra = compactExtra(activity);
  if (extra) {
    parts.push(extra);
  }

  if (activity.preview) {
    const preview = formatPreview(activity.preview, opts.mode);
    if (preview) {
      parts.push(`preview="${preview}"`);
    }
  }

  if (opts.mode === "full") {
    if (activity.sessionKey) {
      parts.push(`sessionKey=${activity.sessionKey}`);
    }
    if (activity.runId) {
      parts.push(`runId=${activity.runId}`);
    }
    if (activity.toolCallId) {
      parts.push(`toolCallId=${activity.toolCallId}`);
    }
  }

  return parts.join(" ");
}
