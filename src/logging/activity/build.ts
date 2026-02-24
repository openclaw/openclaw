import { truncateUtf16Safe } from "../../utils.js";
import { redactSensitiveText } from "../redact.js";
import type { ActivityMeta } from "./types.js";

const PREVIEW_LIMIT_NORMAL = 120;
const PREVIEW_LIMIT_FULL = 240;
const ACTIVITY_KINDS = [
  "inbound",
  "route",
  "queue",
  "run",
  "tool",
  "reply",
  "policy",
  "error",
] as const;
const ACTIVITY_STATUS = [
  "start",
  "ok",
  "error",
  "skip",
  "blocked",
  "queued",
  "dequeued",
  "done",
] as const;

function isActivityKind(value: string): value is ActivityMeta["kind"] {
  return (ACTIVITY_KINDS as readonly string[]).includes(value);
}

function isActivityStatus(value: string): value is Exclude<ActivityMeta["status"], undefined> {
  return (ACTIVITY_STATUS as readonly string[]).includes(value);
}

function normalizeShortText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizePreview(value: unknown, options?: { full?: boolean }): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeShortText(redactSensitiveText(value));
  if (!normalized) {
    return undefined;
  }
  // Store the safer upper bound by default so full-mode renderers can show more detail.
  const limit = options?.full === false ? PREVIEW_LIMIT_NORMAL : PREVIEW_LIMIT_FULL;
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, limit)}…`;
}

function normalizeExtra(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const extra: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!key) {
      continue;
    }
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      extra[key] = raw;
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

function normalizeActivityMeta(
  input: Partial<ActivityMeta>,
  options?: { full?: boolean },
): ActivityMeta | undefined {
  const kind = typeof input.kind === "string" ? input.kind.trim() : "";
  const summary = typeof input.summary === "string" ? normalizeShortText(input.summary) : "";
  if (!kind || !summary || !isActivityKind(kind)) {
    return undefined;
  }
  const preview = normalizePreview(input.preview, options);
  const extra = normalizeExtra(input.extra);
  let status: ActivityMeta["status"];
  if (typeof input.status === "string") {
    const trimmedStatus = input.status.trim();
    if (isActivityStatus(trimmedStatus)) {
      status = trimmedStatus;
    }
  }

  const activity: ActivityMeta = {
    kind,
    summary,
    ...(typeof input.channel === "string" && input.channel.trim()
      ? { channel: input.channel.trim() }
      : {}),
    ...(typeof input.sessionKey === "string" && input.sessionKey.trim()
      ? { sessionKey: input.sessionKey.trim() }
      : {}),
    ...(typeof input.runId === "string" && input.runId.trim() ? { runId: input.runId.trim() } : {}),
    ...(typeof input.toolCallId === "string" && input.toolCallId.trim()
      ? { toolCallId: input.toolCallId.trim() }
      : {}),
    ...(status ? { status } : {}),
    ...(typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? { durationMs: Math.max(0, Math.round(input.durationMs)) }
      : {}),
    ...(typeof input.chars === "number" && Number.isFinite(input.chars)
      ? { chars: Math.max(0, Math.round(input.chars)) }
      : {}),
    ...(preview ? { preview } : {}),
    ...(extra ? { extra } : {}),
  };

  return activity;
}

export function buildActivityMeta(
  input: Partial<ActivityMeta>,
  options?: { full?: boolean },
): ActivityMeta | undefined {
  return normalizeActivityMeta(input, options);
}

export function buildToolActivityLabel(params: {
  tool: string;
  label?: string;
  detail?: string;
}): string {
  const tool = normalizeShortText(params.tool);
  const label = normalizeShortText(params.label ?? "");
  const detail = normalizeShortText(params.detail ?? "");
  if (label && detail) {
    return `${label} ${detail}`;
  }
  if (label) {
    return label;
  }
  if (detail) {
    return `${tool} ${detail}`;
  }
  return tool;
}
