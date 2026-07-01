import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitTrustedDiagnosticEvent,
  isDiagnosticsEnabled,
  type DiagnosticEventPayload,
} from "./diagnostic-events.js";

type DiagnosticUsageEvent = Extract<DiagnosticEventPayload, { type: "model.usage" }>;
type CoreModelUsageEventInput = Omit<DiagnosticUsageEvent, "seq" | "ts" | "type">;
type CoreModelUsageEventListener = (event: DiagnosticUsageEvent) => void;

const listeners = new Set<CoreModelUsageEventListener>();
let modelUsageEventSequence = 0;

function cloneModelUsageEvent(event: DiagnosticUsageEvent): DiagnosticUsageEvent {
  return Object.freeze(structuredClone(event)) as DiagnosticUsageEvent;
}

export function isModelUsagePluginEventsEnabled(config?: OpenClawConfig): boolean {
  return config?.plugins?.modelUsage?.enabled === true;
}

export function shouldEmitModelUsageEvent(config?: OpenClawConfig): boolean {
  return isDiagnosticsEnabled(config) || isModelUsagePluginEventsEnabled(config);
}

export function emitModelUsageEvent(
  config: OpenClawConfig | undefined,
  event: CoreModelUsageEventInput,
): void {
  if (isDiagnosticsEnabled(config)) {
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      ...event,
    });
  }
  if (!isModelUsagePluginEventsEnabled(config)) {
    return;
  }
  const enriched: DiagnosticUsageEvent = {
    type: "model.usage",
    ts: Date.now(),
    seq: ++modelUsageEventSequence,
    ...event,
  };
  for (const listener of listeners) {
    try {
      listener(cloneModelUsageEvent(enriched));
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? (err.stack ?? err.message)
          : typeof err === "string"
            ? err
            : String(err);
      console.error(`[model-usage-events] listener error seq=${enriched.seq}: ${errorMessage}`);
    }
  }
}

export function onCoreModelUsageEvent(listener: CoreModelUsageEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetCoreModelUsageEventsForTest(): void {
  listeners.clear();
  modelUsageEventSequence = 0;
}
