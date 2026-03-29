/**
 * LLM usage event emitter for gateway observability.
 *
 * Writes JSONL directly to the gateway's rolling log file (same file Logstash ingests).
 * Bypasses tslog deliberately — tslog wraps arguments in a nested logObj envelope,
 * but Logstash requires all fields at document root (type: "openclaw" routing).
 *
 * All errors are swallowed silently. Observability failures MUST NOT affect callers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getResolvedLoggerSettings } from '../logging/logger.js';
import type { LlmEventPayload } from './types.js';

// ─── Log file path resolution ────────────────────────────────────────────────
// Uses the same rolling-file path as the gateway logger via getResolvedLoggerSettings().
// This stays in sync with any runtime override (e.g. custom path in openclaw.json).

function resolveLogFilePath(): string {
  try {
    return getResolvedLoggerSettings().file;
  } catch {
    // Fallback: derive today's rolling path directly
    const dir = '/tmp/openclaw';
    const d = new Date();
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return path.join(dir, `openclaw-${ymd}.log`);
  }
}

// ─── Error classification ────────────────────────────────────────────────────

function classifyError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  if (msg.includes('rate limit') || msg.includes('429')) return 'rate_limit';
  if (msg.includes('context length') || msg.includes('context window') || msg.includes('max_tokens'))
    return 'context_length';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound'))
    return 'network';
  if (msg.includes('auth') || msg.includes('403') || msg.includes('401')) return 'auth';
  return 'unknown';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Build and emit an LLM usage event to the gateway log file.
 *
 * Call this from the LLM dispatch wrapper immediately after complete() resolves
 * (success path) or in the catch block when usage data is present (error path).
 *
 * Do NOT call when: an error was thrown AND tokensIn === 0 && tokensOut === 0
 * (network failure — no API response was received, no tokens were processed).
 */
export function emitLlmEvent(opts: {
  level: 'info' | 'error';
  model: string;
  provider: string;
  sessionKey: string;
  startTime: number;           // performance.now() at request dispatch
  tokensIn?: number;
  tokensOut?: number;
  error?: unknown;
}): void {
  try {
    const duration_ms = Math.round(performance.now() - opts.startTime);

    const payload: LlmEventPayload = {
      event: 'llm_event',
      level: opts.level,
      type: 'openclaw',
      time: new Date().toISOString(),
      sessionKey: opts.sessionKey || 'unknown',
      model: opts.model || 'unknown',
      provider: opts.provider || 'unknown',
      duration_ms,
    };

    // Omit token fields entirely when 0 — never set to null
    if (typeof opts.tokensIn === 'number' && opts.tokensIn > 0) {
      payload.tokens_in = opts.tokensIn;
    }
    if (typeof opts.tokensOut === 'number' && opts.tokensOut > 0) {
      payload.tokens_out = opts.tokensOut;
    }

    // Error fields only on error events
    if (opts.level === 'error' && opts.error !== undefined) {
      payload.error_type = classifyError(opts.error);
      payload.error_message = String((opts.error as Error)?.message ?? opts.error).slice(0, 500);
    }

    const line = JSON.stringify(payload) + '\n';
    const logFile = resolveLogFilePath();

    // Ensure directory exists (should already be created by gateway startup)
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line, { encoding: 'utf8' });
  } catch {
    // Swallow all errors — observability failures must never surface to callers
    try {
      process.stderr.write('[observability] Failed to emit llm_event\n');
    } catch { /* nothing */ }
  }
}
