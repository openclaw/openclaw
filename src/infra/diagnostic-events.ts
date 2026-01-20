import type { ClawdbotConfig } from "../config/config.js";

export type DiagnosticUsageEvent = {
  type: "model.usage";
  ts: number;
  seq: number;
  sessionKey?: string;
  sessionId?: string;
  channel?: string;
  provider?: string;
  model?: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    promptTokens?: number;
    total?: number;
  };
  context?: {
    limit?: number;
    used?: number;
  };
  costUsd?: number;
  durationMs?: number;
};

export type DiagnosticEventPayload = DiagnosticUsageEvent;

let seq = 0;
const listeners = new Set<(evt: DiagnosticEventPayload) => void>();

export function isDiagnosticsEnabled(config?: ClawdbotConfig): boolean {
  return config?.diagnostics?.enabled === true;
}

export function emitDiagnosticEvent(event: Omit<DiagnosticEventPayload, "seq" | "ts">) {
  const enriched: DiagnosticEventPayload = {
    ...event,
    seq: (seq += 1),
    ts: Date.now(),
  };
  for (const listener of listeners) {
    try {
      listener(enriched);
    } catch {
      // Ignore listener failures.
    }
  }
}

export function onDiagnosticEvent(listener: (evt: DiagnosticEventPayload) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetDiagnosticEventsForTest(): void {
  seq = 0;
  listeners.clear();
}
