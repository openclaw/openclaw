import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ObservabilityDomain } from "../config/types.observability.js";
import { formatLocalIsoWithOffset } from "../logging/timestamps.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";

export type ObservabilityStatus = "ok" | "error" | "timeout" | "aborted";

export type ObservabilityEventPayload = {
  id: string;
  ts: number;
  seq: number;
  domain: ObservabilityDomain;
  event: string;
  phase?: string;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  status?: ObservabilityStatus;
  durationMs?: number;
  error?: string;
  data?: Record<string, unknown>;
};

export type ObservabilityEventInput = Omit<ObservabilityEventPayload, "id" | "seq" | "ts">;

type ObservabilityEventsGlobalState = {
  seq: number;
  listeners: Set<(evt: ObservabilityEventPayload) => void>;
  dispatchDepth: number;
  mirrorInstalled: boolean;
  configOverrideForTest?: OpenClawConfig;
};

function getObservabilityEventsState(): ObservabilityEventsGlobalState {
  const globalStore = globalThis as typeof globalThis & {
    __openclawObservabilityEventsState?: ObservabilityEventsGlobalState;
  };
  if (!globalStore.__openclawObservabilityEventsState) {
    globalStore.__openclawObservabilityEventsState = {
      seq: 0,
      listeners: new Set<(evt: ObservabilityEventPayload) => void>(),
      dispatchDepth: 0,
      mirrorInstalled: false,
      configOverrideForTest: undefined,
    };
  }
  return globalStore.__openclawObservabilityEventsState;
}

export function isObservabilityDomainEnabled(
  config: OpenClawConfig | undefined,
  domain: ObservabilityDomain,
): boolean {
  const observability = config?.observability;
  if (observability?.enabled === false) {
    return false;
  }
  if (observability?.events?.enabled === false) {
    return false;
  }
  return observability?.events?.domains?.[domain] !== false;
}

function shouldMirrorObservabilityLogs(config?: OpenClawConfig): boolean {
  if (config?.observability?.enabled === false) {
    return false;
  }
  return config?.observability?.logs?.enabled === true;
}

function defaultObservabilityLogPath(): string {
  return path.join(resolvePreferredOpenClawTmpDir(), "openclaw-observability.log");
}

function appendObservabilityLogLine(filePath: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${line}\n`, "utf8");
  } catch {
    // never block runtime activity on observability log writes
  }
}

function sanitizeToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '""';
  }
  if (/^[A-Za-z0-9_./:@%-]+$/.test(trimmed)) {
    return trimmed;
  }
  return JSON.stringify(trimmed);
}

function flattenData(
  value: Record<string, unknown> | undefined,
  prefix = "",
  out: Array<[string, string]> = [],
): Array<[string, string]> {
  if (!value) {
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (item == null) {
      continue;
    }
    if (typeof item === "string") {
      out.push([nextKey, sanitizeToken(item)]);
      continue;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      out.push([nextKey, String(item)]);
      continue;
    }
    if (Array.isArray(item)) {
      out.push([nextKey, sanitizeToken(JSON.stringify(item))]);
      continue;
    }
    if (typeof item === "object") {
      flattenData(item as Record<string, unknown>, nextKey, out);
      continue;
    }
  }
  return out;
}

function pushPart(parts: string[], key: string, value: unknown): void {
  if (value == null) {
    return;
  }
  if (typeof value === "string") {
    parts.push(`${key}=${sanitizeToken(value)}`);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    parts.push(`${key}=${value}`);
    return;
  }
  parts.push(`${key}=${sanitizeToken(JSON.stringify(value))}`);
}

function getDataRecord(event: ObservabilityEventPayload): Record<string, unknown> {
  return event.data ?? {};
}

function formatCommonParts(
  event: ObservabilityEventPayload,
  includeEventIds: boolean,
  activity: string,
): string[] {
  const parts = [formatLocalIsoWithOffset(new Date(event.ts)), activity];
  if (includeEventIds) {
    parts.push(`id=${event.id}`);
    parts.push(`seq=${event.seq}`);
  }
  pushPart(parts, "run", event.runId);
  pushPart(parts, "sess", event.sessionId);
  pushPart(parts, "skey", event.sessionKey);
  pushPart(parts, "agent", event.agentId);
  pushPart(parts, "status", event.status);
  if (typeof event.durationMs === "number") {
    parts.push(`dur=${event.durationMs}ms`);
  }
  pushPart(parts, "err", event.error);
  return parts;
}

function formatTailLlmEvent(event: ObservabilityEventPayload, includeEventIds: boolean): string {
  const data = getDataRecord(event);
  const parts = formatCommonParts(event, includeEventIds, `llm.${event.phase ?? event.event}`);
  pushPart(parts, "prov", data.provider);
  pushPart(parts, "model", data.model);
  pushPart(parts, "attempt", data.attempt);
  pushPart(parts, "profile", data.authProfileId);
  if (typeof data.stopReason === "string") {
    pushPart(parts, "stop", data.stopReason);
  }
  if (typeof data.timedOut === "boolean" && data.timedOut) {
    parts.push("timedOut=true");
  }
  if (typeof data.aborted === "boolean" && data.aborted) {
    parts.push("aborted=true");
  }
  const prompt =
    data.prompt && typeof data.prompt === "object"
      ? (data.prompt as Record<string, unknown>)
      : undefined;
  if (prompt) {
    pushPart(parts, "prompt.chars", prompt.chars);
    pushPart(parts, "imgs", prompt.images);
  }
  const usage =
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : undefined;
  if (usage) {
    pushPart(parts, "tok.in", usage.input);
    pushPart(parts, "tok.out", usage.output);
    pushPart(parts, "tok.total", usage.total);
    pushPart(parts, "tok.cacheRead", usage.cacheRead);
    pushPart(parts, "tok.cacheWrite", usage.cacheWrite);
  }
  pushPart(parts, "compact", data.compactionCount);
  return parts.join(" ");
}

function formatTailToolEvent(event: ObservabilityEventPayload, includeEventIds: boolean): string {
  const data = getDataRecord(event);
  const parts = formatCommonParts(event, includeEventIds, `tool.${event.phase ?? event.event}`);
  pushPart(parts, "tool", data.toolName);
  pushPart(parts, "call", data.toolCallId);
  pushPart(parts, "meta", data.meta);
  const argsSummary =
    data.argsSummary && typeof data.argsSummary === "object"
      ? (data.argsSummary as Record<string, unknown>)
      : undefined;
  const resultSummary =
    data.resultSummary && typeof data.resultSummary === "object"
      ? (data.resultSummary as Record<string, unknown>)
      : undefined;
  if (argsSummary) {
    pushPart(parts, "args.kind", argsSummary.kind);
    pushPart(parts, "action", argsSummary.action);
    pushPart(parts, "path", argsSummary.path ?? argsSummary.file_path);
    pushPart(parts, "cmd", argsSummary.command ?? argsSummary.cmd);
    pushPart(parts, "query", argsSummary.query);
    pushPart(parts, "url", argsSummary.url);
  }
  if (resultSummary) {
    pushPart(parts, "result.kind", resultSummary.kind);
    pushPart(parts, "result.keys", resultSummary.keys);
  }
  return parts.join(" ");
}

function formatTailRunEvent(event: ObservabilityEventPayload, includeEventIds: boolean): string {
  const data = getDataRecord(event);
  const parts = formatCommonParts(
    event,
    includeEventIds,
    `run.${event.event}${event.phase ? `.${event.phase}` : ""}`,
  );
  pushPart(parts, "attempt", data.attempt);
  return parts.join(" ");
}

function formatTailQueueEvent(event: ObservabilityEventPayload, includeEventIds: boolean): string {
  const data = getDataRecord(event);
  const parts = formatCommonParts(event, includeEventIds, `queue.${event.phase ?? event.event}`);
  pushPart(parts, "lane", data.lane);
  pushPart(parts, "q", data.queueSize);
  if (typeof data.waitMs === "number") {
    parts.push(`wait=${data.waitMs}ms`);
  }
  return parts.join(" ");
}

function formatTailSessionEvent(
  event: ObservabilityEventPayload,
  includeEventIds: boolean,
): string {
  const data = getDataRecord(event);
  const parts = formatCommonParts(
    event,
    includeEventIds,
    `session.${event.event}${event.phase ? `.${event.phase}` : ""}`,
  );
  pushPart(parts, "state", data.state);
  pushPart(parts, "prev", data.prevState);
  pushPart(parts, "reason", data.reason);
  pushPart(parts, "q", data.queueDepth);
  if (typeof data.ageMs === "number") {
    parts.push(`age=${data.ageMs}ms`);
  }
  return parts.join(" ");
}

function formatTailLogLine(event: ObservabilityEventPayload, includeEventIds: boolean): string {
  if (event.domain === "llm" && event.event === "call") {
    return formatTailLlmEvent(event, includeEventIds);
  }
  if (event.domain === "tool" && event.event === "call") {
    return formatTailToolEvent(event, includeEventIds);
  }
  if (event.domain === "run") {
    return formatTailRunEvent(event, includeEventIds);
  }
  if (event.domain === "queue") {
    return formatTailQueueEvent(event, includeEventIds);
  }
  if (event.domain === "session") {
    return formatTailSessionEvent(event, includeEventIds);
  }

  const parts = [
    formatLocalIsoWithOffset(new Date(event.ts)),
    `${event.domain}.${event.event}${event.phase ? `.${event.phase}` : ""}`,
  ];
  if (includeEventIds) {
    parts.push(`eventId=${event.id}`);
    parts.push(`seq=${event.seq}`);
  }
  if (event.runId) {
    parts.push(`runId=${sanitizeToken(event.runId)}`);
  }
  if (event.sessionId) {
    parts.push(`sessionId=${sanitizeToken(event.sessionId)}`);
  }
  if (event.sessionKey) {
    parts.push(`sessionKey=${sanitizeToken(event.sessionKey)}`);
  }
  if (event.agentId) {
    parts.push(`agentId=${sanitizeToken(event.agentId)}`);
  }
  if (event.status) {
    parts.push(`status=${event.status}`);
  }
  if (typeof event.durationMs === "number") {
    parts.push(`durationMs=${event.durationMs}`);
  }
  if (event.error) {
    parts.push(`error=${sanitizeToken(event.error)}`);
  }
  for (const [key, item] of flattenData(event.data)) {
    parts.push(`${key}=${item}`);
  }
  return parts.join(" ");
}

function ensureObservabilityLogMirrorInstalled(): void {
  const state = getObservabilityEventsState();
  if (state.mirrorInstalled) {
    return;
  }
  state.mirrorInstalled = true;
  state.listeners.add((event) => {
    let config: OpenClawConfig | undefined;
    try {
      config = state.configOverrideForTest ?? loadConfig();
    } catch {
      config = undefined;
    }
    if (!shouldMirrorObservabilityLogs(config)) {
      return;
    }
    const includeEventIds = config?.observability?.logs?.includeEventIds === true;
    const format = config?.observability?.logs?.format ?? "tail";
    const filePath = config?.observability?.logs?.filePath ?? defaultObservabilityLogPath();
    if (format === "json") {
      appendObservabilityLogLine(
        filePath,
        JSON.stringify({
          ts: formatLocalIsoWithOffset(new Date(event.ts)),
          ...(includeEventIds ? { id: event.id, seq: event.seq } : {}),
          domain: event.domain,
          event: event.event,
          phase: event.phase,
          runId: event.runId,
          sessionId: event.sessionId,
          sessionKey: event.sessionKey,
          agentId: event.agentId,
          status: event.status,
          durationMs: event.durationMs,
          error: event.error,
          data: event.data,
        }),
      );
      return;
    }
    appendObservabilityLogLine(filePath, formatTailLogLine(event, includeEventIds));
  });
}

export function emitObservabilityEvent(event: ObservabilityEventInput): void {
  const state = getObservabilityEventsState();
  ensureObservabilityLogMirrorInstalled();
  if (state.dispatchDepth > 100) {
    console.error(
      `[observability-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping domain=${event.domain} event=${event.event}`,
    );
    return;
  }

  const seq = (state.seq += 1);
  const enriched = {
    ...event,
    id: `obs_${Date.now()}_${seq}`,
    seq,
    ts: Date.now(),
  } satisfies ObservabilityEventPayload;
  state.dispatchDepth += 1;
  for (const listener of state.listeners) {
    try {
      listener(enriched);
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? (err.stack ?? err.message)
          : typeof err === "string"
            ? err
            : String(err);
      console.error(
        `[observability-events] listener error domain=${enriched.domain} seq=${enriched.seq}: ${errorMessage}`,
      );
    }
  }
  state.dispatchDepth -= 1;
}

export function emitRuntimeEvent(event: ObservabilityEventInput): void {
  emitObservabilityEvent(event);
}

export function onObservabilityEvent(
  listener: (evt: ObservabilityEventPayload) => void,
): () => void {
  const state = getObservabilityEventsState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function resetObservabilityEventsForTest(): void {
  const state = getObservabilityEventsState();
  state.seq = 0;
  state.listeners.clear();
  state.dispatchDepth = 0;
  state.mirrorInstalled = false;
  state.configOverrideForTest = undefined;
}

export function setObservabilityConfigOverrideForTest(config?: OpenClawConfig): void {
  const state = getObservabilityEventsState();
  state.configOverrideForTest = config;
}
