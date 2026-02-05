import { Type } from "@sinclair/typebox";
import type { CronDelivery, CronMessageChannel } from "../../cron/types.js";
import { loadConfig } from "../../config/config.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

// NOTE: We use Type.Object({}, { additionalProperties: true }) for job/patch
// instead of CronAddParamsSchema/CronJobPatchSchema because the gateway schemas
// contain nested unions. Tool schemas need to stay provider-friendly, so we
// accept "any object" here and validate at runtime.

const CRON_ACTIONS = ["status", "list", "add", "update", "remove", "run", "runs", "wake"] as const;

const CRON_WAKE_MODES = ["now", "next-heartbeat"] as const;

const REMINDER_CONTEXT_MESSAGES_MAX = 10;
const REMINDER_CONTEXT_PER_MESSAGE_MAX = 220;
const REMINDER_CONTEXT_TOTAL_MAX = 700;
const REMINDER_CONTEXT_MARKER = "\n\nRecent context:\n";

// Flattened schema: runtime validates per-action requirements.
const CronToolSchema = Type.Object({
  action: stringEnum(CRON_ACTIONS),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
  includeDisabled: Type.Optional(Type.Boolean()),
  job: Type.Optional(Type.Object({}, { additionalProperties: true })),
  jobId: Type.Optional(Type.String()),
  id: Type.Optional(Type.String()),
  patch: Type.Optional(Type.Object({}, { additionalProperties: true })),
  text: Type.Optional(Type.String()),
  mode: optionalStringEnum(CRON_WAKE_MODES),
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

function truncateText(input: string, maxLen: number) {
  if (input.length <= maxLen) {
    return input;
  }
  const truncated = truncateUtf16Safe(input, Math.max(0, maxLen - 3)).trimEnd();
  return `${truncated}...`;
}

function normalizeContextText(raw: string) {
  return raw.replace(/\s+/g, " ").trim();
}

function extractMessageText(message: ChatMessage): { role: string; text: string } | null {
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user" && role !== "assistant") {
    return null;
  }
  const content = message.content;
  if (typeof content === "string") {
    const normalized = normalizeContextText(content);
    return normalized ? { role, text: normalized } : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as { type?: unknown }).type !== "text") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) {
      chunks.push(text);
    }
  }
  const joined = normalizeContextText(chunks.join(" "));
  return joined ? { role, text: joined } : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  // - dm:<peerId>
  // - <channel>:dm:<peerId>
  // - <channel>:<accountId>:dm:<peerId>
  // - <channel>:group:<peerId>
  // - <channel>:channel:<peerId>
  // Threaded sessions append :thread:<id>, which we strip so delivery targets the parent peer.
  // NOTE: Telegram forum topics encode as <chatId>:topic:<topicId> and should be preserved.
  const markerIndex = parts.findIndex(
    (part) => part === "dm" || part === "group" || part === "channel",
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

export function createCronTool(opts?: CronToolOptions): AnyAgentTool {
  return {
    label: "Cron",
    name: "cron",
    description: `Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.

ACTIONS:
- status: Check cron scheduler status
- list: List jobs (use includeDisabled:true to include disabled)
- add: Create job (requires job object, see schema below)
- update: Modify job (requires jobId + patch object)
- remove: Delete job (requires jobId)
- run: Trigger job immediately (requires jobId)
- runs: Get job run history (requires jobId)
- wake: Send wake event (requires text, optional mode)

JOB SCHEMA (for add action):
{
  "name": "string (optional)",
  "schedule": { ... },      // Required: when to run
  "payload": { ... },       // Required: what to execute
  "delivery": { ... },      // Optional: announce summary (isolated only)
  "sessionTarget": "main" | "isolated",  // Required
  "enabled": true | false   // Optional, default true
}

SCHEDULE TYPES (schedule.kind):
- "at": One-shot at absolute time
  { "kind": "at", "at": "<ISO-8601 timestamp>" }
- "every": Recurring interval
  { "kind": "every", "everyMs": <interval-ms>, "anchorMs": <optional-start-ms> }
- "cron": Cron expression
  { "kind": "cron", "expr": "<cron-expression>", "tz": "<optional-timezone>" }

ISO timestamps without an explicit timezone are treated as UTC.

PAYLOAD TYPES (payload.kind):
- "systemEvent": Injects text as system event into session
  { "kind": "systemEvent", "text": "<message>" }
- "agentTurn": Runs agent with message (isolated sessions only)
  { "kind": "agentTurn", "message": "<prompt>", "model": "<optional>", "thinking": "<optional>", "timeoutSeconds": <optional> }

DELIVERY (isolated-only, top-level):
  { "mode": "none|announce", "channel": "<optional>", "to": "<optional>", "bestEffort": <optional-bool> }
  - Default for isolated agentTurn jobs (when delivery omitted): "announce"
  - If the task needs to send to a specific chat/recipient, set delivery.channel/to here; do not call messaging tools inside the run.

CRITICAL CONSTRAINTS:
- sessionTarget="main" REQUIRES payload.kind="systemEvent"
- sessionTarget="isolated" REQUIRES payload.kind="agentTurn"
Default: prefer isolated agentTurn jobs unless the user explicitly wants a main-session system event.

WAKE MODES (for wake action):
- "next-heartbeat" (default): Wake on next heartbeat
- "now": Wake immediately

Use jobId as the canonical identifier; id is accepted for compatibility. Use contextMessages (0-10) to add previous messages as context to the job text.`,
    parameters: CronToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const gatewayOpts: GatewayCallOptions = {
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 60_000,
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
          if (!params.job || typeof params.job !== "object") {
            throw new Error("job required");
          }
          const job = normalizeCronJobCreate(params.job) ?? params.job;
          if (job && typeof job === "object" && !("agentId" in job)) {
            const cfg = loadConfig();
            const agentId = opts?.agentSessionKey
              ? resolveSessionAgentId({ sessionKey: opts.agentSessionKey, config: cfg })
              : undefined;
            if (agentId) {
              (job as { agentId?: string }).agentId = agentId;
            }
          }

          // [Fix Issue 3] Infer delivery target from session key for isolated jobs if not provided
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
            const hasTarget =
              (typeof delivery?.channel === "string" && delivery.channel.trim()) ||
              (typeof delivery?.to === "string" && delivery.to.trim());
            const shouldInfer =
              (deliveryValue == null || delivery) && mode !== "none" && !hasTarget;
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
          const patch = normalizeCronJobPatch(params.patch) ?? params.patch;
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
          return jsonResult(await callGatewayTool("cron.run", gatewayOpts, { id }));
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
