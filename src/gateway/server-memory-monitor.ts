import os from "node:os";
import v8 from "node:v8";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import {
  DEFAULT_MEMORY_CRITICAL_MB,
  DEFAULT_MEMORY_CRITICAL_PERCENT,
  DEFAULT_MEMORY_WARN_MB,
  DEFAULT_MEMORY_WARN_PERCENT,
  MEMORY_CHECK_INTERVAL_MS,
} from "./server-constants.js";

export function resolveMemoryThresholds(cfg: OpenClawConfig): {
  warnMB: number;
  criticalMB: number;
} {
  const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
  let warnMB =
    cfg.gateway?.memory?.warnMB ??
    Math.max(512, Math.floor((totalMB * DEFAULT_MEMORY_WARN_PERCENT) / 100));
  let criticalMB =
    cfg.gateway?.memory?.criticalMB ??
    Math.max(1024, Math.floor((totalMB * DEFAULT_MEMORY_CRITICAL_PERCENT) / 100));

  // Clamp minimums even for explicit config values
  warnMB = Math.max(512, warnMB);
  criticalMB = Math.max(1024, criticalMB);

  // Ensure critical > warn
  if (criticalMB <= warnMB) {
    const tmp = criticalMB;
    criticalMB = warnMB + 256;
    warnMB = tmp;
  }

  return { warnMB, criticalMB };
}

export function startMemoryMonitor(params: {
  log: SubsystemLogger;
  warnMB: number;
  criticalMB: number;
  onCritical: () => void;
}): { interval: ReturnType<typeof setInterval> } {
  const { log, warnMB, criticalMB, onCritical } = params;
  let criticalFired = false;

  const check = () => {
    const mem = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const rssMB = Math.round(mem.rss / 1024 / 1024);

    if (rssMB > criticalMB) {
      if (!criticalFired) {
        criticalFired = true;
        log.error(
          `RSS ${rssMB}MB exceeds critical threshold ${criticalMB}MB — triggering graceful restart`,
          {
            rssMB,
            heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
            externalMB: Math.round(mem.external / 1024 / 1024),
            heapSizeLimit: heap.heap_size_limit,
            totalAvailableSize: heap.total_available_size,
          },
        );
        onCritical();
      }
    } else if (rssMB > warnMB) {
      log.warn(
        `RSS ${rssMB}MB exceeds warning threshold ${warnMB}MB`,
        {
          rssMB,
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
          externalMB: Math.round(mem.external / 1024 / 1024),
        },
      );
    } else {
      log.debug(`memory ok: RSS ${rssMB}MB (warn=${warnMB}MB, critical=${criticalMB}MB)`);
    }
  };

  const interval = setInterval(check, MEMORY_CHECK_INTERVAL_MS);
  interval.unref?.();

  return { interval };
}
