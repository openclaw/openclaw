export function formatTokenCount(value) {
    if (value === undefined || !Number.isFinite(value)) {
        return "0";
    }
    const safe = Math.max(0, value);
    if (safe >= 1000000) {
        return `${(safe / 1000000).toFixed(1)}m`;
    }
    if (safe >= 1000) {
        return `${(safe / 1000).toFixed(safe >= 10000 ? 0 : 1)}k`;
    }
    return String(Math.round(safe));
}
export function formatUsd(value) {
    if (value === undefined || !Number.isFinite(value)) {
        return undefined;
    }
    if (value >= 1) {
        return `$${value.toFixed(2)}`;
    }
    if (value >= 0.01) {
        return `$${value.toFixed(2)}`;
    }
    return `$${value.toFixed(4)}`;
}
export function resolveModelCostConfig(params) {
    const provider = params.provider?.trim();
    const model = params.model?.trim();
    if (!provider || !model) {
        return undefined;
    }
    const providers = params.config?.models?.providers ?? {};
    const entry = providers[provider]?.models?.find((item) => item.id === model);
    return entry?.cost;
}
const toNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
export function estimateUsageCost(params) {
    const usage = params.usage;
    const cost = params.cost;
    if (!usage || !cost) {
        return undefined;
    }
    const input = toNumber(usage.input);
    const output = toNumber(usage.output);
    const cacheRead = toNumber(usage.cacheRead);
    const cacheWrite = toNumber(usage.cacheWrite);
    const total = input * cost.input +
        output * cost.output +
        cacheRead * cost.cacheRead +
        cacheWrite * cost.cacheWrite;
    if (!Number.isFinite(total)) {
        return undefined;
    }
    return total / 1000000;
}
