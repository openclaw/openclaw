import { buildActivityMeta } from "./build.js";
import type { ActivityMeta } from "./types.js";

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function extractActivityMetaFromUnknown(value: unknown): ActivityMeta | undefined {
  const record = toObject(value);
  if (!record) {
    return undefined;
  }

  const source =
    toObject(record.activity) &&
    typeof (record.activity as Record<string, unknown>).kind === "string"
      ? (record.activity as Record<string, unknown>)
      : typeof record.kind === "string"
        ? record
        : null;
  if (!source) {
    return undefined;
  }
  return buildActivityMeta(source as Partial<ActivityMeta>);
}

function parseToolLifecycle(message: string): ActivityMeta | undefined {
  const startMatch = message.match(
    /embedded run tool start: runId=([^\s]+) tool=([^\s]+) toolCallId=([^\s]+)/i,
  );
  if (startMatch) {
    return buildActivityMeta({
      kind: "tool",
      summary: `tool ${startMatch[2]} start`,
      runId: startMatch[1],
      toolCallId: startMatch[3],
      status: "start",
      extra: { tool: startMatch[2] },
    });
  }

  const endMatch = message.match(
    /embedded run tool end: runId=([^\s]+) tool=([^\s]+) toolCallId=([^\s]+)/i,
  );
  if (endMatch) {
    return buildActivityMeta({
      kind: "tool",
      summary: `tool ${endMatch[2]} end`,
      runId: endMatch[1],
      toolCallId: endMatch[3],
      status: "done",
      extra: { tool: endMatch[2] },
    });
  }

  return undefined;
}

function parseRunLifecycle(message: string): ActivityMeta | undefined {
  const runStart = message.match(/embedded run start: runId=([^\s]+) sessionId=([^\s]+)/i);
  if (runStart) {
    return buildActivityMeta({
      kind: "run",
      summary: "run start",
      runId: runStart[1],
      sessionKey: runStart[2],
      status: "start",
    });
  }

  const runDone = message.match(
    /embedded run done: runId=([^\s]+) sessionId=([^\s]+) durationMs=([0-9]+) aborted=(true|false)/i,
  );
  if (runDone) {
    return buildActivityMeta({
      kind: "run",
      summary: runDone[4] === "true" ? "run aborted" : "run completed",
      runId: runDone[1],
      sessionKey: runDone[2],
      durationMs: Number(runDone[3]),
      status: runDone[4] === "true" ? "error" : "ok",
    });
  }

  return undefined;
}

function parseQueue(message: string): ActivityMeta | undefined {
  const enqueue = message.match(/lane enqueue: lane=([^\s]+) queueSize=([0-9]+)/i);
  if (enqueue) {
    return buildActivityMeta({
      kind: "queue",
      summary: `lane ${enqueue[1]} enqueue`,
      status: "queued",
      extra: { lane: enqueue[1], queueSize: Number(enqueue[2]) },
    });
  }

  const dequeue = message.match(/lane dequeue: lane=([^\s]+) waitMs=([0-9]+) queueSize=([0-9]+)/i);
  if (dequeue) {
    return buildActivityMeta({
      kind: "queue",
      summary: `lane ${dequeue[1]} dequeue`,
      status: "dequeued",
      durationMs: Number(dequeue[2]),
      extra: { lane: dequeue[1], queueSize: Number(dequeue[3]) },
    });
  }

  const done = message.match(
    /lane task done: lane=([^\s]+) durationMs=([0-9]+) active=([0-9]+) queued=([0-9]+)/i,
  );
  if (done) {
    return buildActivityMeta({
      kind: "queue",
      summary: `lane ${done[1]} task done`,
      status: "done",
      durationMs: Number(done[2]),
      extra: { lane: done[1], active: Number(done[3]), queued: Number(done[4]) },
    });
  }

  return undefined;
}

function parseRoute(message: string): ActivityMeta | undefined {
  const route = message.match(
    /resolveAgentRoute: channel=([^\s]+) accountId=([^\s]+) peer=([^\s]+) guildId=([^\s]+) teamId=([^\s]+) bindings=([0-9]+)/i,
  );
  if (!route) {
    return undefined;
  }
  return buildActivityMeta({
    kind: "route",
    summary: `route resolved for ${route[1]}`,
    channel: route[1],
    status: "ok",
    extra: {
      accountId: route[2],
      peer: route[3],
      guildId: route[4],
      teamId: route[5],
      bindings: Number(route[6]),
    },
  });
}

function parseInboundOrReply(message: string): ActivityMeta | undefined {
  const inbound = message.match(/\[([^\]]+)\]\s+Inbound message\s+(.+)\(([^)]+)\)/i);
  if (inbound) {
    return buildActivityMeta({
      kind: "inbound",
      summary: `inbound message ${inbound[2].trim()}`,
      channel: inbound[1].trim().toLowerCase(),
      status: "ok",
      extra: { details: inbound[3].trim() },
    });
  }

  const replied = message.match(/\[([^\]]+)\]\s+Auto-replied to\s+(.+)/i);
  if (replied) {
    return buildActivityMeta({
      kind: "reply",
      summary: `auto reply sent to ${replied[2].trim()}`,
      channel: replied[1].trim().toLowerCase(),
      status: "ok",
    });
  }

  if (/reply failed/i.test(message)) {
    return buildActivityMeta({
      kind: "reply",
      summary: "reply failed",
      status: "error",
      preview: message,
    });
  }

  return undefined;
}

function parsePolicy(message: string): ActivityMeta | undefined {
  if (/\bblocked\b/i.test(message) || /\bskipping\b/i.test(message)) {
    return buildActivityMeta({
      kind: "policy",
      summary: "policy decision",
      status: /\bblocked\b/i.test(message) ? "blocked" : "skip",
      preview: message,
    });
  }
  return undefined;
}

export function extractActivityMetaFromMessage(message: string): ActivityMeta | undefined {
  const trimmed = message.trim();
  if (!trimmed) {
    return undefined;
  }

  return (
    parseToolLifecycle(trimmed) ??
    parseRunLifecycle(trimmed) ??
    parseQueue(trimmed) ??
    parseRoute(trimmed) ??
    parseInboundOrReply(trimmed) ??
    parsePolicy(trimmed)
  );
}

export function extractActivityMeta(params: {
  activity?: unknown;
  message?: string;
  meta?: unknown;
}): ActivityMeta | undefined {
  return (
    extractActivityMetaFromUnknown(params.activity) ??
    extractActivityMetaFromUnknown(params.meta) ??
    (typeof params.message === "string"
      ? extractActivityMetaFromMessage(params.message)
      : undefined)
  );
}
