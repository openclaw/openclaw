import { emitDiagnosticEvent, } from "../infra/diagnostic-events.js";
const MB = 1024 * 1024;
const DEFAULT_RSS_WARNING_BYTES = 1536 * MB;
const DEFAULT_RSS_CRITICAL_BYTES = 3072 * MB;
const DEFAULT_HEAP_WARNING_BYTES = 1024 * MB;
const DEFAULT_HEAP_CRITICAL_BYTES = 2048 * MB;
const DEFAULT_RSS_GROWTH_WARNING_BYTES = 512 * MB;
const DEFAULT_RSS_GROWTH_CRITICAL_BYTES = 1024 * MB;
const DEFAULT_GROWTH_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_PRESSURE_REPEAT_MS = 5 * 60 * 1000;
const state = {
    lastSample: null,
    lastPressureAtByKey: new Map(),
};
function normalizeMemoryUsage(memory) {
    return {
        rssBytes: memory.rss,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
    };
}
function resolveThresholds(thresholds) {
    return {
        rssWarningBytes: thresholds?.rssWarningBytes ?? DEFAULT_RSS_WARNING_BYTES,
        rssCriticalBytes: thresholds?.rssCriticalBytes ?? DEFAULT_RSS_CRITICAL_BYTES,
        heapUsedWarningBytes: thresholds?.heapUsedWarningBytes ?? DEFAULT_HEAP_WARNING_BYTES,
        heapUsedCriticalBytes: thresholds?.heapUsedCriticalBytes ?? DEFAULT_HEAP_CRITICAL_BYTES,
        rssGrowthWarningBytes: thresholds?.rssGrowthWarningBytes ?? DEFAULT_RSS_GROWTH_WARNING_BYTES,
        rssGrowthCriticalBytes: thresholds?.rssGrowthCriticalBytes ?? DEFAULT_RSS_GROWTH_CRITICAL_BYTES,
        growthWindowMs: thresholds?.growthWindowMs ?? DEFAULT_GROWTH_WINDOW_MS,
        pressureRepeatMs: thresholds?.pressureRepeatMs ?? DEFAULT_PRESSURE_REPEAT_MS,
    };
}
function pickThresholdPressure(params) {
    const { memory, thresholds } = params;
    if (memory.rssBytes >= thresholds.rssCriticalBytes) {
        return {
            level: "critical",
            reason: "rss_threshold",
            memory,
            thresholdBytes: thresholds.rssCriticalBytes,
        };
    }
    if (memory.heapUsedBytes >= thresholds.heapUsedCriticalBytes) {
        return {
            level: "critical",
            reason: "heap_threshold",
            memory,
            thresholdBytes: thresholds.heapUsedCriticalBytes,
        };
    }
    if (memory.rssBytes >= thresholds.rssWarningBytes) {
        return {
            level: "warning",
            reason: "rss_threshold",
            memory,
            thresholdBytes: thresholds.rssWarningBytes,
        };
    }
    if (memory.heapUsedBytes >= thresholds.heapUsedWarningBytes) {
        return {
            level: "warning",
            reason: "heap_threshold",
            memory,
            thresholdBytes: thresholds.heapUsedWarningBytes,
        };
    }
    return null;
}
function pickGrowthPressure(params) {
    const { previous, current, thresholds } = params;
    if (!previous) {
        return null;
    }
    const windowMs = current.ts - previous.ts;
    if (windowMs <= 0 || windowMs > thresholds.growthWindowMs) {
        return null;
    }
    const rssGrowthBytes = current.memory.rssBytes - previous.memory.rssBytes;
    if (rssGrowthBytes >= thresholds.rssGrowthCriticalBytes) {
        return {
            level: "critical",
            reason: "rss_growth",
            memory: current.memory,
            thresholdBytes: thresholds.rssGrowthCriticalBytes,
            rssGrowthBytes,
            windowMs,
        };
    }
    if (rssGrowthBytes >= thresholds.rssGrowthWarningBytes) {
        return {
            level: "warning",
            reason: "rss_growth",
            memory: current.memory,
            thresholdBytes: thresholds.rssGrowthWarningBytes,
            rssGrowthBytes,
            windowMs,
        };
    }
    return null;
}
function shouldEmitPressure(pressure, now, repeatMs) {
    const key = `${pressure.level}:${pressure.reason}`;
    const lastAt = state.lastPressureAtByKey.get(key);
    if (lastAt !== undefined && now - lastAt < repeatMs) {
        return false;
    }
    state.lastPressureAtByKey.set(key, now);
    return true;
}
export function emitDiagnosticMemorySample(options) {
    const now = options?.now ?? Date.now();
    const memory = normalizeMemoryUsage(options?.memoryUsage ?? process.memoryUsage());
    const current = { ts: now, memory };
    const thresholds = resolveThresholds(options?.thresholds);
    const shouldEmitSample = options?.emitSample !== false;
    if (shouldEmitSample) {
        emitDiagnosticEvent({
            type: "diagnostic.memory.sample",
            memory,
            uptimeMs: options?.uptimeMs ?? Math.round(process.uptime() * 1000),
        });
    }
    const pressure = pickThresholdPressure({ memory, thresholds }) ??
        pickGrowthPressure({ previous: state.lastSample, current, thresholds });
    state.lastSample = current;
    if (pressure && shouldEmitPressure(pressure, now, thresholds.pressureRepeatMs)) {
        emitDiagnosticEvent({
            type: "diagnostic.memory.pressure",
            ...pressure,
        });
    }
    return memory;
}
export function resetDiagnosticMemoryForTest() {
    state.lastSample = null;
    state.lastPressureAtByKey.clear();
}
