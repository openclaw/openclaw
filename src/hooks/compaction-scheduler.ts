import type { OpenClawConfig } from "../config/config.js";
import { isFeatureEnabled } from "../config/types.debugging.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createInternalHookEvent, triggerInternalHook } from "./internal-hooks.js";

let compactionTimer: NodeJS.Timeout | null = null;
const log = createSubsystemLogger("compaction");

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function resolveCompactionEntry(cfg?: OpenClawConfig): Record<string, unknown> | undefined {
  const entry = cfg?.hooks?.internal?.entries?.compaction as Record<string, unknown> | undefined;
  return entry && typeof entry === "object" ? entry : undefined;
}

export function startCompactionScheduler(cfg?: OpenClawConfig): void {
  stopCompactionScheduler();
  if (!cfg?.hooks?.internal?.enabled) {
    return;
  }
  const entry = resolveCompactionEntry(cfg);
  if (!entry || entry.enabled !== true) {
    return;
  }
  const strategy = readString(entry.strategy, "scheduled");
  if (strategy !== "scheduled") {
    return;
  }
  const intervalHours = readNumber(entry.scheduleIntervalHours, 4);
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) {
    return;
  }
  const debugEnabled = isFeatureEnabled(cfg.debugging, "compaction-hooks");
  const intervalMs = intervalHours * 60 * 60 * 1000;
  compactionTimer = setInterval(() => {
    const hookEvent = createInternalHookEvent(
      "agent",
      "compaction:scheduled",
      "system:compaction",
      {
        cfg,
        scheduleIntervalHours: intervalHours,
        triggeredAt: new Date().toISOString(),
      },
    );
    if (debugEnabled) {
      log.debug?.("Scheduled compaction hook emitted", {
        scheduleIntervalHours: intervalHours,
      });
    }
    void triggerInternalHook(hookEvent);
  }, intervalMs);
}

export function stopCompactionScheduler(): void {
  if (compactionTimer) {
    clearInterval(compactionTimer);
    compactionTimer = null;
  }
}
