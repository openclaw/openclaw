/**
 * call-trace-writer.ts
 *
 * Subscribes to `model.call` and `tool.call` diagnostic events and appends them
 * to JSONL files under `diagnostics.callTrace.dir` (default: ~/.openclaw/call-traces/).
 *
 * One file per day: calls/YYYY-MM-DD.jsonl, tools/YYYY-MM-DD.jsonl
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

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function appendJsonl(filePath: string, record: unknown): void {
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(filePath, line, "utf8");
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
 * Start listening for call-trace diagnostic events and writing them to JSONL files.
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

  const logLlmCalls = ct.logLlmCalls !== false; // default true
  const logToolCalls = ct.logToolCalls === true; // default false
  if (!logLlmCalls && !logToolCalls) {
    return undefined;
  }

  const baseDir = ct.dir ?? DEFAULT_DIR;
  const retainDays = ct.retainDays ?? DEFAULT_RETAIN_DAYS;

  const llmDir = path.join(baseDir, "calls");
  const toolDir = path.join(baseDir, "tools");

  if (logLlmCalls) {
    ensureDir(llmDir);
  }
  if (logToolCalls) {
    ensureDir(toolDir);
  }

  // Purge stale files on startup (best-effort).
  if (logLlmCalls) {
    purgeOldFiles(llmDir, retainDays);
  }
  if (logToolCalls) {
    purgeOldFiles(toolDir, retainDays);
  }

  const unsub = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
    const stamp = dateStamp();

    if (evt.type === "model.call" && logLlmCalls) {
      const filePath = path.join(llmDir, `${stamp}.jsonl`);
      appendJsonl(filePath, evt);
      return;
    }

    if (evt.type === "tool.call" && logToolCalls) {
      const filePath = path.join(toolDir, `${stamp}.jsonl`);
      appendJsonl(filePath, evt);
      return;
    }
  });

  return unsub;
}
