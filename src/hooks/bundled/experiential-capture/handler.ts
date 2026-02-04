import crypto from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookConfig } from "../../../config/types.js";
import type {
  MeridiaBuffer,
  MeridiaExperienceRecord,
  MeridiaToolResultContext,
  MeridiaTraceEvent,
} from "../../../meridia/types.js";
import type { HookHandler } from "../../hooks.js";
import { MERIDIA_DEFAULT_EVALUATION_MODEL } from "../../../meridia/constants.js";
import { evaluateHeuristic, evaluateWithLlm } from "../../../meridia/evaluate.js";
import {
  appendJsonl,
  dateKeyUtc,
  readJsonIfExists,
  resolveMeridiaDir,
  writeJson,
} from "../../../meridia/storage.js";
import { resolveHookConfig } from "../../config.js";

type LimitedInfo = { reason: "min_interval" | "max_per_hour"; detail?: string };

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNumber(cfg: HookConfig | undefined, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = cfg?.[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  for (const key of keys) {
    const value = cfg?.[key];
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return fallback;
}

function readString(cfg: HookConfig | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = cfg?.[key];
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function safeFileKey(raw: string): string {
  return raw.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureBuffer(seed: Partial<MeridiaBuffer>): MeridiaBuffer {
  const now = nowIso();
  return {
    version: 1,
    sessionId: seed.sessionId,
    sessionKey: seed.sessionKey,
    createdAt: seed.createdAt ?? now,
    updatedAt: now,
    toolResultsSeen: seed.toolResultsSeen ?? 0,
    captured: seed.captured ?? 0,
    lastSeenAt: seed.lastSeenAt,
    lastCapturedAt: seed.lastCapturedAt,
    recentCaptures: seed.recentCaptures ?? [],
    recentEvaluations: seed.recentEvaluations ?? [],
    lastError: seed.lastError,
  };
}

function pruneOld(buffer: MeridiaBuffer, nowMs: number): MeridiaBuffer {
  const hourAgo = nowMs - 60 * 60 * 1000;
  const recentCaptures = buffer.recentCaptures.filter((c) => Date.parse(c.ts) >= hourAgo);
  const recentEvaluations = buffer.recentEvaluations.slice(-50);
  return {
    ...buffer,
    recentCaptures,
    recentEvaluations,
  };
}

const experientialCapture: HookHandler = async (event) => {
  if (event.type !== "agent" || event.action !== "tool:result") {
    return;
  }

  const context = asObject(event.context) ?? {};
  const cfg = (context.cfg as OpenClawConfig | undefined) ?? undefined;
  const hookCfg = resolveHookConfig(cfg, "experiential-capture");
  if (hookCfg?.enabled !== true) {
    return;
  }

  const toolName = typeof context.toolName === "string" ? context.toolName : "";
  const toolCallId = typeof context.toolCallId === "string" ? context.toolCallId : "";
  if (!toolName || !toolCallId) {
    return;
  }

  const sessionId = typeof context.sessionId === "string" ? context.sessionId : undefined;
  const sessionKey = typeof context.sessionKey === "string" ? context.sessionKey : event.sessionKey;
  const runId = typeof context.runId === "string" ? context.runId : undefined;
  const meta = typeof context.meta === "string" ? context.meta : undefined;
  const isError = Boolean(context.isError);
  const args = context.args;
  const result = context.result;

  const meridiaDir = resolveMeridiaDir(cfg, "experiential-capture");
  const dateKey = dateKeyUtc(event.timestamp);
  const tracePath = path.join(meridiaDir, "trace", `${dateKey}.jsonl`);
  const recordPath = path.join(meridiaDir, "records", "experiential", `${dateKey}.jsonl`);

  const bufferKey = safeFileKey(sessionId ?? sessionKey ?? event.sessionKey);
  const bufferPath = path.join(meridiaDir, "buffers", `${bufferKey}.json`);
  const now = nowIso();
  const nowMs = Date.now();

  const minThreshold = readNumber(
    hookCfg,
    ["min_significance_threshold", "minSignificanceThreshold", "threshold"],
    0.6,
  );
  const maxPerHour = readNumber(hookCfg, ["max_captures_per_hour", "maxCapturesPerHour"], 10);
  const minIntervalMs = readNumber(hookCfg, ["min_interval_ms", "minIntervalMs"], 5 * 60 * 1000);
  const evaluationTimeoutMs = readNumber(
    hookCfg,
    ["evaluation_timeout_ms", "evaluationTimeoutMs"],
    3500,
  );
  // Intentionally fixed to a single model so Meridia capture behavior is stable across machines.
  // Config overrides are ignored (but may still be recorded in trace by downstream tooling).
  const evaluationModel = MERIDIA_DEFAULT_EVALUATION_MODEL;

  const ctx: MeridiaToolResultContext = {
    cfg,
    runId,
    sessionId,
    sessionKey,
    toolName,
    toolCallId,
    meta,
    isError,
    args,
    result,
  };

  let buffer = ensureBuffer(
    (await readJsonIfExists<MeridiaBuffer>(bufferPath)) ?? { sessionId, sessionKey },
  );
  buffer = pruneOld(buffer, nowMs);
  buffer.toolResultsSeen += 1;
  buffer.lastSeenAt = now;
  buffer.updatedAt = now;

  const limited: LimitedInfo | undefined = (() => {
    if (buffer.lastCapturedAt) {
      const last = Date.parse(buffer.lastCapturedAt);
      if (Number.isFinite(last) && nowMs - last < minIntervalMs) {
        return { reason: "min_interval" };
      }
    }
    if (buffer.recentCaptures.length >= maxPerHour) {
      return { reason: "max_per_hour", detail: `${buffer.recentCaptures.length}/${maxPerHour}` };
    }
    return undefined;
  })();

  let evaluation = evaluateHeuristic(ctx);
  let evaluationError: string | undefined;
  try {
    if (cfg) {
      evaluation = await evaluateWithLlm({
        cfg,
        ctx,
        modelRef: evaluationModel,
        timeoutMs: evaluationTimeoutMs,
      });
    }
  } catch (err) {
    evaluationError = err instanceof Error ? err.message : String(err);
    buffer.lastError = { ts: now, toolName, message: evaluationError };
  }

  const shouldCapture =
    !limited && evaluation.score >= minThreshold && evaluation.recommendation === "capture";

  buffer.recentEvaluations.push({
    ts: now,
    toolName,
    score: evaluation.score,
    recommendation: evaluation.recommendation,
    reason: evaluation.reason,
  });
  if (buffer.recentEvaluations.length > 50) {
    buffer.recentEvaluations.splice(0, buffer.recentEvaluations.length - 50);
  }

  let recordId: string | undefined;
  if (shouldCapture) {
    recordId = crypto.randomUUID();
    const record: MeridiaExperienceRecord = {
      id: recordId,
      ts: now,
      sessionKey,
      sessionId,
      runId,
      tool: { name: toolName, callId: toolCallId, meta, isError },
      data: { args, result },
      evaluation,
    };
    await appendJsonl(recordPath, record);
    buffer.captured += 1;
    buffer.lastCapturedAt = now;
    buffer.recentCaptures.push({
      ts: now,
      toolName,
      score: evaluation.score,
      recordId,
    });
    buffer = pruneOld(buffer, nowMs);
  }

  const traceEvent: MeridiaTraceEvent = {
    type: "tool_result",
    ts: now,
    sessionId,
    sessionKey,
    runId,
    toolName,
    toolCallId,
    meta,
    isError,
    decision: shouldCapture ? "capture" : "skip",
    error: evaluationError,
    score: evaluation.score,
    threshold: minThreshold,
    limited,
    eval: {
      kind: evaluation.kind,
      model: evaluation.model,
      score: evaluation.score,
      reason: evaluation.reason,
      durationMs: evaluation.durationMs,
    },
    recordId,
  };
  await appendJsonl(tracePath, traceEvent);
  await writeJson(bufferPath, buffer);
};

export default experientialCapture;
