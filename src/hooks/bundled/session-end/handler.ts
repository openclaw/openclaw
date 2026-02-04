import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { MeridiaBuffer, MeridiaTraceEvent } from "../../../meridia/types.js";
import type { HookHandler } from "../../hooks.js";
import {
  appendJsonl,
  dateKeyUtc,
  readJsonIfExists,
  resolveMeridiaDir,
  writeJson,
} from "../../../meridia/storage.js";
import { resolveHookConfig } from "../../config.js";

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function safeFileKey(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function nowIso(): string {
  return new Date().toISOString();
}

function resolveSessionIdFromEntry(value: unknown): string | undefined {
  const obj = asObject(value);
  if (!obj) {
    return undefined;
  }
  const sessionId = obj.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
}

const sessionEnd: HookHandler = async (event) => {
  if (event.type !== "command") {
    return;
  }
  if (event.action !== "new" && event.action !== "stop") {
    return;
  }

  const context = asObject(event.context) ?? {};
  const cfg = (context.cfg as OpenClawConfig | undefined) ?? undefined;
  const hookCfg = resolveHookConfig(cfg, "session-end");
  if (hookCfg?.enabled !== true) {
    return;
  }

  const sessionKey = typeof context.sessionKey === "string" ? context.sessionKey : event.sessionKey;
  const sessionId =
    (typeof context.sessionId === "string" && context.sessionId.trim()
      ? context.sessionId.trim()
      : undefined) ??
    resolveSessionIdFromEntry(context.previousSessionEntry) ??
    resolveSessionIdFromEntry(context.sessionEntry);

  const meridiaDir = resolveMeridiaDir(cfg, "session-end");
  const dateKey = dateKeyUtc(event.timestamp);
  const ts = nowIso();
  const tracePath = path.join(meridiaDir, "trace", `${dateKey}.jsonl`);

  const bufferKey = safeFileKey(sessionId ?? sessionKey ?? event.sessionKey);
  const bufferPath = path.join(meridiaDir, "buffers", `${bufferKey}.json`);
  const buffer = await readJsonIfExists<MeridiaBuffer>(bufferPath);

  const summaryDir = path.join(meridiaDir, "sessions", dateKey);
  const summaryPath = path.join(
    summaryDir,
    `${ts.replaceAll(":", "-")}-${sessionId ?? "unknown"}.json`,
  );
  const summary = {
    ts,
    action: event.action,
    sessionId,
    sessionKey,
    buffer,
  };
  await writeJson(summaryPath, summary);

  const traceEvent: MeridiaTraceEvent = {
    type: "session_end",
    ts,
    action: event.action,
    sessionId,
    sessionKey,
    summaryPath,
  };
  await appendJsonl(tracePath, traceEvent);
};

export default sessionEnd;
