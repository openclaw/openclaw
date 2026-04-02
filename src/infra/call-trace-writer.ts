/**
 * call-trace-writer.ts
 *
 * Subscribes to `model.call`, `tool.call`, and `turn.summary` diagnostic events
 * and appends them to daily JSONL files under `diagnostics.callTrace.dir`.
 *
 * File patterns:
 *   <dir>/calls/YYYY-MM-DD.jsonl — model.call + tool.call records
 *   <dir>/turns/YYYY-MM-DD.jsonl — turn.summary (per-turn aggregate) records
 *
 * Each line is a JSON object with a `type` field:
 *   - "model.call":   per-LLM-call record (tokens, costUsd, duration, turnId, agentId)
 *   - "tool.call":    per-tool record (duration, error status, turnId, agentId, toolInput)
 *   - "turn.summary": full per-turn aggregate (usage, cost, trigger metadata) — turns/ only
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  type DiagnosticEventPayload,
  isDiagnosticsEnabled,
  onDiagnosticEvent,
} from "./diagnostic-events.js";

const DEFAULT_DIR = path.join(process.env["HOME"] ?? "/tmp", ".openclaw", "traces");
const DEFAULT_RETAIN_DAYS = 30;

function dateStamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function appendJsonl(filePath: string, record: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
}

function purgeOldFiles(dir: string, retainDays: number): void {
  try {
    const cutoffMs = Date.now() - retainDays * 86_400_000;
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      try {
        const stat = fs.statSync(full);
        if (stat.isFile() && stat.mtimeMs < cutoffMs) {
          fs.unlinkSync(full);
        }
      } catch {
        // Ignore individual file errors.
      }
    }
  } catch {
    // Ignore purge errors.
  }
}

/**
 * Start listening for call-trace diagnostic events and writing them to daily
 * JSONL files:
 *   - calls/YYYY-MM-DD.jsonl  → model.call + tool.call
 *   - turns/YYYY-MM-DD.jsonl  → turn.summary (per-turn aggregate)
 *
 * Returns an unsubscribe function.
 */
export function startCallTraceWriter(config: OpenClawConfig): (() => void) | undefined {
  if (!isDiagnosticsEnabled(config)) {
    return undefined;
  }
  const ct = config.diagnostics?.callTrace;
  if (!ct?.enabled) {
    return undefined;
  }

  const logTurnSummaries = ct.logTurnSummaries !== false; // default true  — turn.summary (per-turn aggregate) → turns/
  const logLlmCalls = ct.logLlmCalls !== false; // default true  — model.call  (per-LLM-call) → calls/
  const logToolCalls = ct.logToolCalls === true; // default false — tool.call   (per-tool) → calls/
  if (!logTurnSummaries && !logLlmCalls && !logToolCalls) {
    return undefined;
  }

  const baseDir = ct.dir ?? DEFAULT_DIR;
  const retainDays = ct.retainDays ?? DEFAULT_RETAIN_DAYS;

  fs.mkdirSync(baseDir, { recursive: true });
  purgeOldFiles(baseDir, retainDays);

  const unsub = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
    const stamp = dateStamp();

    if (evt.type === "turn.summary") {
      if (!logTurnSummaries) {
        return;
      }
      const filePath = path.join(baseDir, "turns", `${stamp}.jsonl`);
      appendJsonl(filePath, evt);
      return;
    }

    if (evt.type === "model.call") {
      if (!logLlmCalls) {
        return;
      }
      const filePath = path.join(baseDir, "calls", `${stamp}.jsonl`);
      appendJsonl(filePath, evt);
      return;
    }

    if (evt.type === "tool.call") {
      if (!logToolCalls) {
        return;
      }
      const filePath = path.join(baseDir, "calls", `${stamp}.jsonl`);
      appendJsonl(filePath, evt);
      return;
    }
  });

  return unsub;
}
