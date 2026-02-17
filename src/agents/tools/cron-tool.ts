import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import type { CronDelivery, CronMessageChannel } from "../../cron/types.js";
import { normalizeHttpWebhookUrl } from "../../cron/webhook-url.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import { isRecord, truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const CRON_ACTIONS = ["status", "list", "add", "update", "remove", "run", "runs", "wake"] as const;

const CRON_SESSION_TARGETS = ["main", "isolated"] as const;
const CRON_SCHEDULE_KINDS = ["at", "every", "cron"] as const;
const CRON_PAYLOAD_KINDS = ["systemEvent", "agentTurn"] as const;
const CRON_DELIVERY_MODES = ["none", "announce", "webhook"] as const;

const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;
const CRON_RUN_MODES = ["due", "force"] as const;

const REMINDER_CONTEXT_MESSAGES_MAX = 10;
const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
const REMINDER_CONTEXT_TOTAL_MAX = 700;
const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";

const CronScheduleInputSchema = Type.Object(
  {
    kind: stringEnum(CRON_SCHEDULE_KINDS),
    at: Type.Optional(Type.String({ description: 'Required when kind="at"' })),
    everyMs: Type.Optional(Type.Number({ minimum: 1, description: 'Required when kind="every"' })),
    anchorMs: Type.Optional(Type.Number({ minimum: 0 })),
    expr: Type.Optional(Type.String({ description: 'Required when kind="cron"' })),
    tz: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronPayloadInputSchema = Type.Object(
  {
    kind: stringEnum(CRON_PAYLOAD_KINDS),
    text: Type.Optional(Type.String({ description: 'Required when kind="systemEvent"' })),
    message: Type.Optional(Type.String({ description: 'Required when kind="agentTurn"' })),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
    allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const CronDeliveryInputSchema = Type.Object(
  {
    mode: stringEnum(CRON_DELIVERY_MODES),
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    bestEffort: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const CronDeliveryPatchInputSchema = Type.Object(
  {
    mode: optionalStringEnum(CRON_DELIVERY_MODES),
    channel: Type.Optional(Type.String()),
    to: Type.Optional(Type.String()),
    bestEffort: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const CronJobInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    schedule: CronScheduleInputSchema,
    sessionTarget: stringEnum(CRON_SESSION_TARGETS),
    wakeMode: optionalStringEnum(CRON_WAKE_MODES),
    payload: CronPayloadInputSchema,
    enabled: Type.Optional(Type.Boolean()),
    deleteAfterRun: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
    delivery: Type.Optional(CronDeliveryInputSchema),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const CronJobPatchInputSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1 })),
    sessionTarget: optionalStringEnum(CRON_SESSION_TARGETS),
    wakeMode: optionalStringEnum(CRON_WAKE_MODES),
    enabled: Type.Optional(Type.Boolean()),
    deleteAfterRun: Type.Optional(Type.Boolean()),
    description: Type.Optional(Type.String()),
    schedule: Type.Optional(CronScheduleInputSchema),
    payload: Type.Optional(
      Type.Object(
        {
          kind: Type.Optional(stringEnum(CRON_PAYLOAD_KINDS)),
          text: Type.Optional(Type.String()),
          message: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          thinking: Type.Optional(Type.String()),
          timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
          allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    delivery: Type.Optional(CronDeliveryPatchInputSchema),
    agentId: Type.Optional(Type.String()),
    sessionKey: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

// Keep a flat top-level object schema for provider compatibility.
// action decides which fields are used; runtime still validates.
const CronToolSchema = Type.Object({
  action: stringEnum(CRON_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  includeDisabled: Type.Optional(Type.Boolean()),
  job: Type.Optional(CronJobInputSchema),
  jobId: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  patch: Type.Optional(CronJobPatchInputSchema),
  // Flat-params recovery fields for non-frontier models
  name: Type.Optional(Type.String()),
  schedule: Type.Optional(CronScheduleInputSchema),
  sessionTarget: optionalStringEnum(CRON_SESSION_TARGETS),
  wakeMode: optionalStringEnum(CRON_WAKE_MODES),
  payload: Type.Optional(CronPayloadInputSchema),
  delivery: Type.Optional(CronDeliveryInputSchema),
  enabled: Type.Optional(Type.Boolean()),
  deleteAfterRun: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinking: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
  allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
  text: Type.Optional(Type.String()),
  sessionKey: Type.Optional(Type.String()),
  mode: optionalStringEnum(CRON_WAKE_MODES),
  runMode: optionalStringEnum(CRON_RUN_MODES),
  contextMessages: Type.Optional(
    Type.Number({ minimum: 0, maximum: REMINDER_CONTEXT_MESSAGES_MAX }),
  ),
});

type CronToolOptions = {
  agentSessionKey?: string;
};

type ChatMessage = {
  role?: unknown;
  content?: unknown;
};

function stripExistingContext(text: string) {
  const index = text.indexOf(REMINDER_CONTEXT_MARKER);
  if (index === -1) {
    return text;
  }
  return text.slice(0, index).trim();
}

function buildReminderAgentTurnMessage(text: string) {
  const reminderText = stripExistingContext(text).trim();
  if (!reminderText) {
    return "Send the scheduled reminder now.";
  }
  return [
    "A scheduled reminder is firing now.",
    "Reply to the user with the reminder text below.",
    "Do not mention cron jobs, tools, or internal implementation details.",
    "",
    reminderText,
  ].join("\n");
}

function truncateText(input: string, maxLen: number) {
  if (input.length <= maxLen) {
    return input;
  }
  const truncated = truncateUtf16Safe(input, Math.max(0, maxLen - 3)).trimEnd();
  return `${truncated}...`;
}

function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const text = extractTextFromChatContent(message.content);
  return text ? { role, text } : null;
}

async function buildReminderContextLines(params: {
  agentSessionKey?: string;
  gatewayOpts: GatewayCallOptions;
  contextMessages: number;
}) {
  const maxMessages = Math.min(
    REMINDER_CONTEXT_MESSAGES_MAX,
    Math.max(0, Math.floor(params.contextMessages)),
  );
  if (maxMessages <= 0) {
    return [];
  }
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return [];
  }
  const cfg = loadConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const resolvedKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
  try {
    const res = await callGatewayTool<{ messages: Array<unknown> }>(
      "chat.history",
      params.gatewayOpts,
      {
        sessionKey: resolvedKey,
        limit: maxMessages,
      },
    );
    const messages = Array.isArray(res?.messages) ? res.messages : [];
    const parsed = messages
      .map((msg) => extractMessageText(msg as ChatMessage))
      .filter((msg): msg is { role: string; text: string } => Boolean(msg));
    const recent = parsed.slice(-maxMessages);
    if (recent.length === 0) {
      return [];
    }
    const lines: string[] = [];
    let total = 0;
    for (const entry of recent) {
      const label = entry.role === "user" ? "User" : "Assistant";
      const text = truncateText(entry.text, REMINDER_CONTEXT_PER_MESSAGE_MAX);
      const line = `- ${label}: ${text}`;
      total += line.length;
      if (total > REMINDER_CONTEXT_TOTAL_MAX) {
        break;
      }
      lines.push(line);
    }
    return lines;
  } catch {
    return [];
  }
}

function stripThreadSuffixFromSessionKey(sessionKey: string): string {
  const normalized = sessionKey.toLowerCase();
  const idx = normalized.lastIndexOf(":thread:");
  if (idx <= 0) {
    return sessionKey;
  }
  const parent = sessionKey.slice(0, idx).trim();
  return parent ? parent : sessionKey;
}

function inferDeliveryFromSessionKey(agentSessionKey?: string): CronDelivery | null {
  const rawSessionKey = agentSessionKey?.trim();
  if (!rawSessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(stripThreadSuffixFromSessionKey(rawSessionKey));
  if (!parsed || !parsed.rest) {
    return null;
  }
  const parts = parsed.rest.split(":").filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  const head = parts[0]?.trim().toLowerCase();
  if (!head || head === "main" || head === "subagent" || head === "acp") {
    return null;
  }

  // buildAgentPeerSessionKey encodes peers as:
  // - direct:<peerId>
  // - <channel>:direct:<peerId>
  // - <channel>:<accountId>:direct:<peerId>
  // - <channel>:group:<peerId>
  // - <channel>:channel:<peerId>
  // Note: legacy keys may use "dm" instead of "direct".
  // Threaded sessions append :thread:<id>, which we strip so delivery targets the parent peer.
  // NOTE: Telegram forum topics encode as <chatId>:topic:<topicId> and should be preserved.
  const markerIndex = parts.findIndex(
    (part) => part === "direct" || part === "dm" || part === "group" || part === "channel",
  );
  if (markerIndex === -1) {
    return null;
  }
  const peerId = parts
    .slice(markerIndex + 1)
    .join(":")
    .trim();
  if (!peerId) {
    return null;
  }

  let channel: CronMessageChannel | undefined;
  if (markerIndex >= 1) {
    channel = parts[0]?.trim().toLowerCase() as CronMessageChannel;
  }

  const delivery: CronDelivery = { mode: "announce", to: peerId };
  if (channel) {
    delivery.channel = channel;
  }
  return delivery;
}

function normalizeScheduleKind(raw: unknown): "at" | "every" | "cron" | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "at" || value === "every" || value === "cron") {
    return value;
  }
  return undefined;
}

function normalizePayloadKind(raw: unknown): "systemEvent" | "agentTurn" | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "systemevent") {
    return "systemEvent";
  }
  if (value === "agentturn") {
    return "agentTurn";
  }
  return undefined;
}

function normalizeDeliveryMode(raw: unknown): "none" | "announce" | "webhook" | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "deliver") {
    return "announce";
  }
  if (value === "none" || value === "announce" || value === "webhook") {
    return value;
  }
  return undefined;
}

function normalizeSessionTarget(raw: unknown): "main" | "isolated" | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "main" || value === "isolated") {
    return value;
  }
  return undefined;
}

function normalizeWakeMode(raw: unknown): "now" | "next-heartbeat" | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim().toLowerCase();
  if (value === "now" || value === "next-heartbeat") {
    return value;
  }
  return undefined;
}

function sanitizeCronScheduleForGateway(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }
  const schedule = raw;
  const at = typeof schedule.at === "string" && schedule.at.trim() ? schedule.at.trim() : "";
  const everyMs =
    typeof schedule.everyMs === "number" && Number.isFinite(schedule.everyMs)
      ? Math.max(1, Math.floor(schedule.everyMs))
      : undefined;
  const anchorMs =
    typeof schedule.anchorMs === "number" && Number.isFinite(schedule.anchorMs)
      ? Math.max(0, Math.floor(schedule.anchorMs))
      : undefined;
  const expr =
    typeof schedule.expr === "string" && schedule.expr.trim() ? schedule.expr.trim() : "";
  const tz = typeof schedule.tz === "string" && schedule.tz.trim() ? schedule.tz.trim() : undefined;

  let kind = normalizeScheduleKind(schedule.kind);
  if (kind === "at" && !at) {
    kind = undefined;
  } else if (kind === "every" && everyMs === undefined) {
    kind = undefined;
  } else if (kind === "cron" && !expr) {
    kind = undefined;
  }
  if (!kind) {
    if (at) {
      kind = "at";
    } else if (everyMs !== undefined) {
      kind = "every";
    } else if (expr) {
      kind = "cron";
    }
  }
  if (!kind) {
    return null;
  }

  if (kind === "at") {
    return { kind: "at", at };
  }
  if (kind === "every") {
    const out: Record<string, unknown> = { kind: "every" };
    out.everyMs = everyMs;
    if (anchorMs !== undefined) {
      out.anchorMs = anchorMs;
    }
    return out;
  }
  const out: Record<string, unknown> = { kind: "cron", expr };
  if (tz) {
    out.tz = tz;
  }
  return out;
}

function sanitizeCronPayloadForGateway(
  raw: unknown,
  opts?: { allowPartial?: boolean },
): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }
  const payload = raw;
  const allowPartial = opts?.allowPartial === true;
  const text =
    typeof payload.text === "string" && payload.text.trim()
      ? payload.text.trim()
      : typeof payload.message === "string" && payload.message.trim()
        ? payload.message.trim()
        : "";
  const message =
    typeof payload.message === "string" && payload.message.trim()
      ? payload.message.trim()
      : typeof payload.text === "string" && payload.text.trim()
        ? payload.text.trim()
        : "";

  let kind = normalizePayloadKind(payload.kind);
  if (!kind) {
    const hasMessage = Boolean(message);
    const hasText = Boolean(text);
    const hasAgentTurnHint =
      typeof payload.model === "string" ||
      typeof payload.thinking === "string" ||
      typeof payload.timeoutSeconds === "number" ||
      typeof payload.allowUnsafeExternalContent === "boolean";
    if (hasMessage) {
      kind = "agentTurn";
    } else if (hasText) {
      kind = "systemEvent";
    } else if (hasAgentTurnHint) {
      kind = "agentTurn";
    }
  }
  if (!kind) {
    return null;
  }
  if (kind === "systemEvent" && !text && message) {
    kind = "agentTurn";
  } else if (kind === "agentTurn" && !message && text && !allowPartial) {
    kind = "systemEvent";
  }

  if (kind === "systemEvent") {
    if (!text && !allowPartial) {
      return null;
    }
    const out: Record<string, unknown> = { kind: "systemEvent" };
    if (text) {
      out.text = text;
    }
    return out;
  }

  if (!message && !allowPartial) {
    return null;
  }
  const out: Record<string, unknown> = { kind: "agentTurn" };
  if (message) {
    out.message = message;
  }
  if (typeof payload.model === "string" && payload.model.trim()) {
    out.model = payload.model.trim();
  }
  if (typeof payload.thinking === "string" && payload.thinking.trim()) {
    out.thinking = payload.thinking.trim();
  }
  if (typeof payload.timeoutSeconds === "number" && Number.isFinite(payload.timeoutSeconds)) {
    out.timeoutSeconds = Math.max(1, Math.floor(payload.timeoutSeconds));
  }
  if (typeof payload.allowUnsafeExternalContent === "boolean") {
    out.allowUnsafeExternalContent = payload.allowUnsafeExternalContent;
  }
  if (typeof payload.deliver === "boolean") {
    out.deliver = payload.deliver;
  }
  if (typeof payload.channel === "string" && payload.channel.trim()) {
    out.channel = payload.channel.trim();
  }
  if (typeof payload.to === "string" && payload.to.trim()) {
    out.to = payload.to.trim();
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    out.bestEffortDeliver = payload.bestEffortDeliver;
  }
  return out;
}

function sanitizeCronDeliveryForGateway(
  raw: unknown,
  opts?: { patch?: boolean },
): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }
  const delivery = raw;
  const patchMode = opts?.patch === true;
  let mode = normalizeDeliveryMode(delivery.mode);
  const hasTarget =
    (typeof delivery.channel === "string" && delivery.channel.trim()) ||
    (typeof delivery.to === "string" && delivery.to.trim());
  if (!mode && !patchMode && hasTarget) {
    mode = "announce";
  }
  if (!mode && !patchMode) {
    return null;
  }

  const out: Record<string, unknown> = {};
  if (mode) {
    out.mode = mode;
  }
  if (typeof delivery.channel === "string" && delivery.channel.trim()) {
    out.channel = delivery.channel.trim();
  }
  if (typeof delivery.to === "string" && delivery.to.trim()) {
    out.to = delivery.to.trim();
  }
  if (typeof delivery.bestEffort === "boolean") {
    out.bestEffort = delivery.bestEffort;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeCronStatePatchForGateway(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }
  const state = raw;
  const out: Record<string, unknown> = {};

  const copyInt = (key: string, minimum = 0) => {
    const value = state[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.max(minimum, Math.floor(value));
    }
  };
  copyInt("nextRunAtMs");
  copyInt("runningAtMs");
  copyInt("lastRunAtMs");
  copyInt("lastDurationMs");
  copyInt("consecutiveErrors");

  if (state.lastStatus === "ok" || state.lastStatus === "error" || state.lastStatus === "skipped") {
    out.lastStatus = state.lastStatus;
  }
  if (typeof state.lastError === "string") {
    out.lastError = state.lastError;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function sanitizeCronAddJobForGateway(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }
  const input = raw;
  const next: Record<string, unknown> = {};

  if (typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed) {
      next.name = trimmed;
    }
  }
  if (input.agentId === null) {
    next.agentId = null;
  } else if (typeof input.agentId === "string") {
    const trimmed = input.agentId.trim();
    if (trimmed) {
      next.agentId = trimmed;
    }
  }
  if (input.sessionKey === null) {
    next.sessionKey = null;
  } else if (typeof input.sessionKey === "string") {
    const trimmed = input.sessionKey.trim();
    if (trimmed) {
      next.sessionKey = trimmed;
    }
  }
  if (typeof input.description === "string") {
    next.description = input.description.trim();
  }
  if (typeof input.enabled === "boolean") {
    next.enabled = input.enabled;
  }
  if (typeof input.deleteAfterRun === "boolean") {
    next.deleteAfterRun = input.deleteAfterRun;
  }
  if ("sessionTarget" in input) {
    const normalized = normalizeSessionTarget(input.sessionTarget);
    if (normalized) {
      next.sessionTarget = normalized;
    }
  }
  if ("wakeMode" in input) {
    const normalized = normalizeWakeMode(input.wakeMode);
    if (normalized) {
      next.wakeMode = normalized;
    }
  }
  if ("schedule" in input) {
    const sanitized = sanitizeCronScheduleForGateway(input.schedule);
    if (sanitized) {
      next.schedule = sanitized;
    } else if (isRecord(input.schedule)) {
      next.schedule = input.schedule;
    }
  }
  if ("payload" in input) {
    const sanitized = sanitizeCronPayloadForGateway(input.payload, { allowPartial: false });
    if (sanitized) {
      next.payload = sanitized;
    } else if (isRecord(input.payload)) {
      next.payload = input.payload;
    }
  }
  if ("delivery" in input) {
    const sanitized = sanitizeCronDeliveryForGateway(input.delivery, { patch: false });
    if (sanitized) {
      next.delivery = sanitized;
    }
  }

  const payloadKind = isRecord(next.payload) ? normalizePayloadKind(next.payload.kind) : undefined;
  const sessionTarget =
    typeof next.sessionTarget === "string" ? normalizeSessionTarget(next.sessionTarget) : undefined;
  const resolvedSessionTarget =
    sessionTarget ??
    (payloadKind === "systemEvent" ? "main" : payloadKind === "agentTurn" ? "isolated" : undefined);
  if (resolvedSessionTarget && !sessionTarget) {
    next.sessionTarget = resolvedSessionTarget;
  }
  if (resolvedSessionTarget === "main" && isRecord(next.delivery)) {
    const mode = normalizeDeliveryMode(next.delivery.mode);
    if (mode !== "webhook") {
      delete next.delivery;
    }
  }

  return next;
}

function sanitizeCronPatchForGateway(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }
  const input = raw;
  const next: Record<string, unknown> = {};

  if ("name" in input && typeof input.name === "string") {
    const trimmed = input.name.trim();
    if (trimmed) {
      next.name = trimmed;
    }
  }
  if ("agentId" in input) {
    if (input.agentId === null) {
      next.agentId = null;
    } else if (typeof input.agentId === "string") {
      const trimmed = input.agentId.trim();
      if (trimmed) {
        next.agentId = trimmed;
      }
    }
  }
  if ("sessionKey" in input) {
    if (input.sessionKey === null) {
      next.sessionKey = null;
    } else if (typeof input.sessionKey === "string") {
      const trimmed = input.sessionKey.trim();
      if (trimmed) {
        next.sessionKey = trimmed;
      }
    }
  }
  if ("description" in input && typeof input.description === "string") {
    next.description = input.description.trim();
  }
  if ("enabled" in input && typeof input.enabled === "boolean") {
    next.enabled = input.enabled;
  }
  if ("deleteAfterRun" in input && typeof input.deleteAfterRun === "boolean") {
    next.deleteAfterRun = input.deleteAfterRun;
  }
  if ("sessionTarget" in input) {
    const normalized = normalizeSessionTarget(input.sessionTarget);
    if (normalized) {
      next.sessionTarget = normalized;
    }
  }
  if ("wakeMode" in input) {
    const normalized = normalizeWakeMode(input.wakeMode);
    if (normalized) {
      next.wakeMode = normalized;
    }
  }
  if ("schedule" in input) {
    const sanitized = sanitizeCronScheduleForGateway(input.schedule);
    if (sanitized) {
      next.schedule = sanitized;
    } else if (isRecord(input.schedule)) {
      next.schedule = input.schedule;
    }
  }
  if ("payload" in input) {
    const sanitized = sanitizeCronPayloadForGateway(input.payload, { allowPartial: true });
    if (sanitized) {
      next.payload = sanitized;
    } else if (isRecord(input.payload)) {
      next.payload = input.payload;
    }
  }
  if ("delivery" in input) {
    const sanitized = sanitizeCronDeliveryForGateway(input.delivery, { patch: true });
    if (sanitized) {
      next.delivery = sanitized;
    }
  }
  if ("state" in input) {
    const sanitized = sanitizeCronStatePatchForGateway(input.state);
    if (sanitized) {
      next.state = sanitized;
    } else if (isRecord(input.state)) {
      next.state = input.state;
    }
  }

  return next;
}

export function createCronTool(opts?: CronToolOptions): AnyAgentTool {
  return {
    label: "Cron",
    name: "cron",
    description: `Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.

This tool wraps Gateway cron endpoints:
- action="status" -> cron.status({})
- action="list" -> cron.list({ includeDisabled? })
- action="add" -> cron.add(job)
- action="update" -> cron.update({ id|jobId, patch })
- action="remove" -> cron.remove({ id|jobId })
- action="run" -> cron.run({ id|jobId, mode? })
- action="runs" -> cron.runs({ id|jobId })

TOOL CALL ENVELOPE (this tool):
{
  "action": "status|list|add|update|remove|run|runs|wake",
  "gatewayUrl": "<optional override>",
  "gatewayToken": "<optional override>",
  "timeoutMs": <optional number>,
  "includeDisabled": <optional bool for list>,
  "job": { ... },       // required for add
  "patch": { ... },     // required for update
  "jobId": "<id>",      // preferred for update/remove/run/runs
  "id": "<id>",         // compatibility alias of jobId
  "text": "<message>",  // required for wake
  "mode": "next-heartbeat|now", // optional for wake, default next-heartbeat
  "runMode": "due|force",       // optional for run, default due
  "contextMessages": 0-10,       // optional reminder context helper
  "sessionKey": "session key" // optional; origin session namespace for reminders and fallback routing
}

ADD JOB SCHEMA (maps to cron.add):
{
  "name": "string",                 // required by gateway (tool may infer fallback name)
  "schedule": { ... },              // required
  "sessionTarget": "main|isolated", // required by gateway (tool may infer from payload.kind)
  "wakeMode": "now|next-heartbeat", // optional, defaults to "now"
  "payload": { ... },               // required
  "enabled": true|false,            // optional, default true
  "deleteAfterRun": true|false,     // optional; defaults true when schedule.kind="at"
  "description": "string",          // optional
  "delivery": { ... },              // optional
  "agentId": "string|null",         // optional
  "sessionKey": "session key|null" // optional; origin session namespace for reminders and fallback routing
}

SCHEDULE TYPES (schedule.kind):
- "at": one-shot absolute time, ISO-8601 string
  { "kind": "at", "at": "2026-02-16T22:10:49Z" }
- "every": recurring interval
  { "kind": "every", "everyMs": 600000, "anchorMs": <optional> }
- "cron": cron expression
  { "kind": "cron", "expr": "*/10 * * * *", "tz": "<optional>" }
- IMPORTANT: include only the fields for the chosen kind (do not mix at/every/cron fields).

ISO timestamps without explicit timezone are treated as UTC.

PAYLOAD TYPES (payload.kind):
- "systemEvent":
  { "kind": "systemEvent", "text": "<message>" }
- "agentTurn" (isolated sessions only):
  { "kind": "agentTurn", "message": "<prompt>", "model": "<optional>", "thinking": "<optional>", "timeoutSeconds": <optional>, "allowUnsafeExternalContent": <optional> }
- IMPORTANT: for systemEvent include text only; for agentTurn include message (+ optional agentTurn fields).

DELIVERY:
{ "mode": "none|announce|webhook", "channel": "<optional>", "to": "<optional>", "bestEffort": <optional> }
- announce: send completion summary to channel/to
- webhook: send completion callback to delivery.to URL
- default for isolated agentTurn when omitted: { "mode": "announce" }

CRITICAL CONSTRAINTS:
- sessionTarget="main" requires payload.kind="systemEvent"
- sessionTarget="isolated" requires payload.kind="agentTurn"
- delivery.channel/to are only supported for sessionTarget="isolated"
- for webhook callbacks, use delivery.mode="webhook" and set delivery.to URL
- when outbound announce delivery fails, runtime can route fallback notices using job.sessionKey

EXAMPLE (valid add, main/systemEvent):
{
  "action": "add",
  "job": {
    "name": "drink-water",
    "schedule": { "kind": "at", "at": "2026-02-16T22:10:49Z" },
    "sessionTarget": "main",
    "wakeMode": "now",
    "payload": { "kind": "systemEvent", "text": "Reminder: drink water." },
    "enabled": true
  }
}

EXAMPLE (valid add, isolated/agentTurn):
{
  "action": "add",
  "job": {
    "name": "daily-summary",
    "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai" },
    "sessionTarget": "isolated",
    "payload": { "kind": "agentTurn", "message": "Summarize yesterday's thread in 5 bullets." },
    "delivery": { "mode": "announce", "channel": "last" }
  }
}

Use jobId as canonical identifier; id is accepted for compatibility.`,
    parameters: CronToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const timeoutMsRaw =
        typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
          ? Math.floor(params.timeoutMs)
          : undefined;
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: timeoutMsRaw !== undefined && timeoutMsRaw >= 1_000 ? timeoutMsRaw : 60_000,
      };

      switch (action) {
        case "status":
          return jsonResult(await callGatewayTool("cron.status", gatewayOpts, {}));
        case "list":
          return jsonResult(
            await callGatewayTool("cron.list", gatewayOpts, {
              includeDisabled: Boolean(params.includeDisabled),
            }),
          );
        case "add": {
          // Flat-params recovery: non-frontier models (e.g. Grok) sometimes flatten
          // job properties to the top level alongside `action` instead of nesting
          // them inside `job`. When `params.job` is missing or empty, reconstruct
          // a synthetic job object from any recognised top-level job fields.
          // See: https://github.com/openclaw/openclaw/issues/11310
          if (
            !params.job ||
            (typeof params.job === "object" &&
              params.job !== null &&
              Object.keys(params.job as Record<string, unknown>).length === 0)
          ) {
            const JOB_KEYS: ReadonlySet<string> = new Set([
              "name",
              "schedule",
              "sessionTarget",
              "wakeMode",
              "payload",
              "delivery",
              "enabled",
              "description",
              "deleteAfterRun",
              "agentId",
              "sessionKey",
              "message",
              "text",
              "model",
              "thinking",
              "timeoutSeconds",
              "allowUnsafeExternalContent",
            ]);
            const synthetic: Record<string, unknown> = {};
            let found = false;
            for (const key of Object.keys(params)) {
              if (JOB_KEYS.has(key) && params[key] !== undefined) {
                synthetic[key] = params[key];
                found = true;
              }
            }
            // Only use the synthetic job if at least one meaningful field is present
            // (schedule, payload, message, or text are the minimum signals that the
            // LLM intended to create a job).
            if (
              found &&
              (synthetic.schedule !== undefined ||
                synthetic.payload !== undefined ||
                synthetic.message !== undefined ||
                synthetic.text !== undefined)
            ) {
              params.job = synthetic;
            }
          }

          if (!params.job || typeof params.job !== "object") {
            throw new Error("job required");
          }
          const normalizedJob = normalizeCronJobCreate(params.job) ?? params.job;
          const job = sanitizeCronAddJobForGateway(normalizedJob) ?? normalizedJob;
          if (job && typeof job === "object") {
            const cfg = loadConfig();
            const { mainKey, alias } = resolveMainSessionAlias(cfg);
            const resolvedSessionKey = opts?.agentSessionKey
              ? resolveInternalSessionKey({ key: opts.agentSessionKey, alias, mainKey })
              : undefined;
            if (!("agentId" in job)) {
              const agentId = opts?.agentSessionKey
                ? resolveSessionAgentId({ sessionKey: opts.agentSessionKey, config: cfg })
                : undefined;
              if (agentId) {
                (job as { agentId?: string }).agentId = agentId;
              }
            }
            if (!("sessionKey" in job) && resolvedSessionKey) {
              (job as { sessionKey?: string }).sessionKey = resolvedSessionKey;
            }
          }
          if (opts?.agentSessionKey && job && typeof job === "object" && "payload" in job) {
            const payloadValue = (job as { payload?: unknown }).payload;
            const payload = isRecord(payloadValue) ? payloadValue : undefined;
            const payloadKind = normalizePayloadKind(payload?.kind);
            const reminderText =
              payloadKind === "systemEvent" && typeof payload?.text === "string"
                ? payload.text.trim()
                : "";
            const deliveryValue = (job as { delivery?: unknown }).delivery;
            const delivery = isRecord(deliveryValue) ? deliveryValue : undefined;
            const deliveryMode = normalizeDeliveryMode(delivery?.mode);
            const inferredDelivery = inferDeliveryFromSessionKey(opts.agentSessionKey);
            const sessionTarget = normalizeSessionTarget(
              (job as { sessionTarget?: unknown }).sessionTarget,
            );
            const shouldRewriteToSessionScopedReminder =
              Boolean(inferredDelivery) &&
              Boolean(reminderText) &&
              deliveryMode !== "webhook" &&
              (sessionTarget === "main" || sessionTarget === undefined);
            if (shouldRewriteToSessionScopedReminder) {
              (job as { sessionTarget?: string }).sessionTarget = "isolated";
              (job as { payload?: unknown }).payload = {
                kind: "agentTurn",
                message: buildReminderAgentTurnMessage(reminderText),
              };
              (job as { delivery?: unknown }).delivery = {
                ...delivery,
                ...inferredDelivery,
                mode: "announce",
              } satisfies CronDelivery;
            }
          }

          if (
            opts?.agentSessionKey &&
            job &&
            typeof job === "object" &&
            "payload" in job &&
            (job as { payload?: { kind?: string } }).payload?.kind === "agentTurn"
          ) {
            const deliveryValue = (job as { delivery?: unknown }).delivery;
            const delivery = isRecord(deliveryValue) ? deliveryValue : undefined;
            const modeRaw = typeof delivery?.mode === "string" ? delivery.mode : "";
            const mode = modeRaw.trim().toLowerCase();
            if (mode === "webhook") {
              const webhookUrl = normalizeHttpWebhookUrl(delivery?.to);
              if (!webhookUrl) {
                throw new Error(
                  'delivery.mode="webhook" requires delivery.to to be a valid http(s) URL',
                );
              }
              if (delivery) {
                delivery.to = webhookUrl;
              }
            }

            const hasTarget =
              (typeof delivery?.channel === "string" && delivery.channel.trim()) ||
              (typeof delivery?.to === "string" && delivery.to.trim());
            const shouldInfer =
              (deliveryValue == null || delivery) &&
              (mode === "" || mode === "announce") &&
              !hasTarget;
            if (shouldInfer) {
              const inferred = inferDeliveryFromSessionKey(opts.agentSessionKey);
              if (inferred) {
                (job as { delivery?: unknown }).delivery = {
                  ...delivery,
                  ...inferred,
                } satisfies CronDelivery;
              }
            }
          }

          const contextMessages =
            typeof params.contextMessages === "number" && Number.isFinite(params.contextMessages)
              ? params.contextMessages
              : 0;
          if (
            job &&
            typeof job === "object" &&
            "payload" in job &&
            (job as { payload?: { kind?: string; text?: string } }).payload?.kind === "systemEvent"
          ) {
            const payload = (job as { payload: { kind: string; text: string } }).payload;
            if (typeof payload.text === "string" && payload.text.trim()) {
              const contextLines = await buildReminderContextLines({
                agentSessionKey: opts?.agentSessionKey,
                gatewayOpts,
                contextMessages,
              });
              if (contextLines.length > 0) {
                const baseText = stripExistingContext(payload.text);
                payload.text = `${baseText}${REMINDER_CONTEXT_MARKER}${contextLines.join("\n")}`;
              }
            }
          }
          return jsonResult(await callGatewayTool("cron.add", gatewayOpts, job));
        }
        case "update": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          if (!params.patch || typeof params.patch !== "object") {
            throw new Error("patch required");
          }
          const normalizedPatch = normalizeCronJobPatch(params.patch) ?? params.patch;
          const patch = sanitizeCronPatchForGateway(normalizedPatch) ?? normalizedPatch;
          return jsonResult(
            await callGatewayTool("cron.update", gatewayOpts, {
              id,
              patch,
            }),
          );
        }
        case "remove": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          return jsonResult(await callGatewayTool("cron.remove", gatewayOpts, { id }));
        }
        case "run": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          const runMode =
            params.runMode === "due" || params.runMode === "force" ? params.runMode : "force";
          return jsonResult(await callGatewayTool("cron.run", gatewayOpts, { id, mode: runMode }));
        }
        case "runs": {
          const id = readStringParam(params, "jobId") ?? readStringParam(params, "id");
          if (!id) {
            throw new Error("jobId required (id accepted for backward compatibility)");
          }
          return jsonResult(await callGatewayTool("cron.runs", gatewayOpts, { id }));
        }
        case "wake": {
          const text = readStringParam(params, "text", { required: true });
          const mode =
            params.mode === "now" || params.mode === "next-heartbeat"
              ? params.mode
              : "next-heartbeat";
          return jsonResult(
            await callGatewayTool("wake", gatewayOpts, { mode, text }, { expectFinal: false }),
          );
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
