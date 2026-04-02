/**
 * call-trace-writer.ts
 *
 * Subscribes to `model.call` and `tool.call` diagnostic events and appends them
 * to a single JSONL file per day under `diagnostics.callTrace.dir`.
 *
 * File pattern: <dir>/YYYY-MM-DD.jsonl
 * Each line is a JSON object with a `type` field:
 *   - "model.usage": full per-turn aggregate (usage, cost, context, trigger metadata)
 *   - "model.call":  per-LLM-call record (tokens for that call, duration)
 *   - "tool.call":   per-tool record (duration, error status)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import {
  type DiagnosticEventPayload,
  isDiagnosticsEnabled,
  onDiagnosticEvent,
} from "./diagnostic-events.js";

const DEFAULT_DIR = path.join(process.env["HOME"] ?? "/tmp", ".openclaw", "call-traces");
const DEFAULT_RETAIN_DAYS = 30;

function dateStamp(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function appendJsonl(filePath: string, record: unknown): void {
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
 * Start listening for call-trace diagnostic events and writing them to a
 * single JSONL file per day. Returns an unsubscribe function.
 */
export function startCallTraceWriter(config: OpenClawConfig): (() => void) | undefined {
  if (!isDiagnosticsEnabled(config)) {
    return undefined;
  }
  const ct = config.diagnostics?.callTrace;
  if (!ct?.enabled) {
    return undefined;
  }

  const logLlmUsage = ct.logLlmUsage !== false; // default true  — model.usage (per-turn aggregate)
  const logLlmCalls = ct.logLlmCalls !== false; // default true  — model.call  (per-LLM-call)
  const logToolCalls = ct.logToolCalls === true; // default false — tool.call   (per-tool)
  if (!logLlmUsage && !logLlmCalls && !logToolCalls) {
    return undefined;
  }

  const baseDir = ct.dir ?? DEFAULT_DIR;
  const retainDays = ct.retainDays ?? DEFAULT_RETAIN_DAYS;

  fs.mkdirSync(baseDir, { recursive: true });
  purgeOldFiles(baseDir, retainDays);

  const unsub = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
    if (evt.type === "model.usage" && !logLlmUsage) {
      return;
    }
    if (evt.type === "model.call" && !logLlmCalls) {
      return;
    }
    if (evt.type === "tool.call" && !logToolCalls) {
      return;
    }
    if (evt.type !== "model.usage" && evt.type !== "model.call" && evt.type !== "tool.call") {
      return;
    }

    const filePath = path.join(baseDir, `${dateStamp()}.jsonl`);
    appendJsonl(filePath, evt);
  });

  return unsub;
}
