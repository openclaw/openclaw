export function formatDurationCompact(valueMs) {
    if (!valueMs || !Number.isFinite(valueMs) || valueMs <= 0) {
        return "n/a";
    }
    const minutes = Math.max(1, Math.round(valueMs / 60000));
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    const minutesRemainder = minutes % 60;
    if (hours < 24) {
        return minutesRemainder > 0 ? `${hours}h${minutesRemainder}m` : `${hours}h`;
    }
    const days = Math.floor(hours / 24);
    const hoursRemainder = hours % 24;
    return hoursRemainder > 0 ? `${days}d${hoursRemainder}h` : `${days}d`;
}
export function formatTokenShort(value) {
    if (!value || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    const n = Math.floor(value);
    if (n < 1000) {
        return `${n}`;
    }
    if (n < 10000) {
        return `${(n / 1000).toFixed(1).replace(/\\.0$/, "")}k`;
    }
    if (n < 1000000) {
        return `${Math.round(n / 1000)}k`;
    }
    return `${(n / 1000000).toFixed(1).replace(/\\.0$/, "")}m`;
}
export function truncateLine(value, maxLength) {
    if (value.length <= maxLength) {
        return value;
    }
    return `${value.slice(0, maxLength).trimEnd()}...`;
}
export function resolveTotalTokens(entry) {
    if (!entry || typeof entry !== "object") {
        return undefined;
    }
    if (typeof entry.totalTokens === "number" && Number.isFinite(entry.totalTokens)) {
        return entry.totalTokens;
    }
    const input = typeof entry.inputTokens === "number" ? entry.inputTokens : 0;
    const output = typeof entry.outputTokens === "number" ? entry.outputTokens : 0;
    const total = input + output;
    return total > 0 ? total : undefined;
}
export function resolveIoTokens(entry) {
    if (!entry || typeof entry !== "object") {
        return undefined;
    }
    const input = typeof entry.inputTokens === "number" && Number.isFinite(entry.inputTokens)
        ? entry.inputTokens
        : 0;
    const output = typeof entry.outputTokens === "number" && Number.isFinite(entry.outputTokens)
        ? entry.outputTokens
        : 0;
    const total = input + output;
    if (total <= 0) {
        return undefined;
    }
    return { input, output, total };
}
export function formatTokenUsageDisplay(entry) {
    const io = resolveIoTokens(entry);
    const promptCache = resolveTotalTokens(entry);
    const parts = [];
    if (io) {
        const input = formatTokenShort(io.input) ?? "0";
        const output = formatTokenShort(io.output) ?? "0";
        parts.push(`tokens ${formatTokenShort(io.total)} (in ${input} / out ${output})`);
    }
    else if (typeof promptCache === "number" && promptCache > 0) {
        parts.push(`tokens ${formatTokenShort(promptCache)} prompt/cache`);
    }
    if (typeof promptCache === "number" && io && promptCache > io.total) {
        parts.push(`prompt/cache ${formatTokenShort(promptCache)}`);
    }
    return parts.join(", ");
}
