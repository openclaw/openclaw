import { buildUsageHttpErrorSnapshot, fetchJson } from "./provider-usage.fetch.shared.js";
import { clampPercent, PROVIDER_LABELS } from "./provider-usage.shared.js";
export async function fetchGeminiUsage(token, timeoutMs, fetchFn, provider) {
    const res = await fetchJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: "{}",
    }, timeoutMs, fetchFn);
    if (!res.ok) {
        return buildUsageHttpErrorSnapshot({
            provider,
            status: res.status,
        });
    }
    const data = (await res.json());
    const quotas = {};
    for (const bucket of data.buckets || []) {
        const model = bucket.modelId || "unknown";
        const frac = bucket.remainingFraction ?? 1;
        if (!quotas[model] || frac < quotas[model]) {
            quotas[model] = frac;
        }
    }
    const windows = [];
    let proMin = 1;
    let flashMin = 1;
    let hasPro = false;
    let hasFlash = false;
    for (const [model, frac] of Object.entries(quotas)) {
        const lower = model.toLowerCase();
        if (lower.includes("pro")) {
            hasPro = true;
            if (frac < proMin) {
                proMin = frac;
            }
        }
        if (lower.includes("flash")) {
            hasFlash = true;
            if (frac < flashMin) {
                flashMin = frac;
            }
        }
    }
    if (hasPro) {
        windows.push({
            label: "Pro",
            usedPercent: clampPercent((1 - proMin) * 100),
        });
    }
    if (hasFlash) {
        windows.push({
            label: "Flash",
            usedPercent: clampPercent((1 - flashMin) * 100),
        });
    }
    return { provider, displayName: PROVIDER_LABELS[provider], windows };
}
