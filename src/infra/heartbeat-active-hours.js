import { resolveUserTimezone } from "../agents/date-time.js";
const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;
function resolveActiveHoursTimezone(cfg, raw) {
    const trimmed = raw?.trim();
    if (!trimmed || trimmed === "user") {
        return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
    }
    if (trimmed === "local") {
        const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return host?.trim() || "UTC";
    }
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
        return trimmed;
    }
    catch {
        return resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
    }
}
function parseActiveHoursTime(opts, raw) {
    if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) {
        return null;
    }
    const [hourStr, minuteStr] = raw.split(":");
    const hour = Number(hourStr);
    const minute = Number(minuteStr);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
        return null;
    }
    if (hour === 24) {
        if (!opts.allow24 || minute !== 0) {
            return null;
        }
        return 24 * 60;
    }
    return hour * 60 + minute;
}
function resolveMinutesInTimeZone(nowMs, timeZone) {
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        }).formatToParts(new Date(nowMs));
        const map = {};
        for (const part of parts) {
            if (part.type !== "literal") {
                map[part.type] = part.value;
            }
        }
        const hour = Number(map.hour);
        const minute = Number(map.minute);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
            return null;
        }
        return hour * 60 + minute;
    }
    catch {
        return null;
    }
}
export function isWithinActiveHours(cfg, heartbeat, nowMs) {
    const active = heartbeat?.activeHours;
    if (!active) {
        return true;
    }
    const startMin = parseActiveHoursTime({ allow24: false }, active.start);
    const endMin = parseActiveHoursTime({ allow24: true }, active.end);
    if (startMin === null || endMin === null) {
        return true;
    }
    if (startMin === endMin) {
        return false;
    }
    const timeZone = resolveActiveHoursTimezone(cfg, active.timezone);
    const currentMin = resolveMinutesInTimeZone(nowMs ?? Date.now(), timeZone);
    if (currentMin === null) {
        return true;
    }
    if (endMin > startMin) {
        return currentMin >= startMin && currentMin < endMin;
    }
    return currentMin >= startMin || currentMin < endMin;
}
