import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { normalizeUsage } from "../agents/usage.js";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import { resolveSessionFilePath, resolveSessionTranscriptsDirForAgent, } from "../config/sessions/paths.js";
import { stripEnvelope, stripMessageIdHints } from "../shared/chat-envelope.js";
import { countToolResults, extractToolCallNames } from "../utils/transcript-tools.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";
const emptyTotals = () => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
});
const toFiniteNumber = (value) => {
    if (typeof value !== "number") {
        return undefined;
    }
    if (!Number.isFinite(value)) {
        return undefined;
    }
    return value;
};
const extractCostBreakdown = (usageRaw) => {
    if (!usageRaw || typeof usageRaw !== "object") {
        return undefined;
    }
    const record = usageRaw;
    const cost = record.cost;
    if (!cost) {
        return undefined;
    }
    const total = toFiniteNumber(cost.total);
    if (total === undefined || total < 0) {
        return undefined;
    }
    return {
        total,
        input: toFiniteNumber(cost.input),
        output: toFiniteNumber(cost.output),
        cacheRead: toFiniteNumber(cost.cacheRead),
        cacheWrite: toFiniteNumber(cost.cacheWrite),
    };
};
const parseTimestamp = (entry) => {
    const raw = entry.timestamp;
    if (typeof raw === "string") {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.valueOf())) {
            return parsed;
        }
    }
    const message = entry.message;
    const messageTimestamp = toFiniteNumber(message?.timestamp);
    if (messageTimestamp !== undefined) {
        const parsed = new Date(messageTimestamp);
        if (!Number.isNaN(parsed.valueOf())) {
            return parsed;
        }
    }
    return undefined;
};
const parseTranscriptEntry = (entry) => {
    const message = entry.message;
    if (!message || typeof message !== "object") {
        return null;
    }
    const roleRaw = message.role;
    const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : undefined;
    if (!role) {
        return null;
    }
    const usageRaw = message.usage ?? entry.usage;
    const usage = usageRaw ? (normalizeUsage(usageRaw) ?? undefined) : undefined;
    const provider = (typeof message.provider === "string" ? message.provider : undefined) ??
        (typeof entry.provider === "string" ? entry.provider : undefined);
    const model = (typeof message.model === "string" ? message.model : undefined) ??
        (typeof entry.model === "string" ? entry.model : undefined);
    const costBreakdown = extractCostBreakdown(usageRaw);
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    const durationMs = toFiniteNumber(message.durationMs ?? entry.durationMs);
    return {
        message,
        role,
        timestamp: parseTimestamp(entry),
        durationMs,
        usage,
        costTotal: costBreakdown?.total,
        costBreakdown,
        provider,
        model,
        stopReason,
        toolNames: extractToolCallNames(message),
        toolResultCounts: countToolResults(message),
    };
};
const formatDayKey = (date) => date.toLocaleDateString("en-CA", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const computeLatencyStats = (values) => {
    if (!values.length) {
        return undefined;
    }
    const sorted = values.toSorted((a, b) => a - b);
    const total = sorted.reduce((sum, v) => sum + v, 0);
    const count = sorted.length;
    const p95Index = Math.max(0, Math.ceil(count * 0.95) - 1);
    return {
        count,
        avgMs: total / count,
        p95Ms: sorted[p95Index] ?? sorted[count - 1],
        minMs: sorted[0],
        maxMs: sorted[count - 1],
    };
};
const applyUsageTotals = (totals, usage) => {
    totals.input += usage.input ?? 0;
    totals.output += usage.output ?? 0;
    totals.cacheRead += usage.cacheRead ?? 0;
    totals.cacheWrite += usage.cacheWrite ?? 0;
    const totalTokens = usage.total ??
        (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    totals.totalTokens += totalTokens;
};
const applyCostBreakdown = (totals, costBreakdown) => {
    if (costBreakdown === undefined || costBreakdown.total === undefined) {
        return;
    }
    totals.totalCost += costBreakdown.total;
    totals.inputCost += costBreakdown.input ?? 0;
    totals.outputCost += costBreakdown.output ?? 0;
    totals.cacheReadCost += costBreakdown.cacheRead ?? 0;
    totals.cacheWriteCost += costBreakdown.cacheWrite ?? 0;
};
// Legacy function for backwards compatibility (no cost breakdown available)
const applyCostTotal = (totals, costTotal) => {
    if (costTotal === undefined) {
        totals.missingCostEntries += 1;
        return;
    }
    totals.totalCost += costTotal;
};
async function* readJsonlRecords(filePath) {
    const fileStream = fs.createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) {
                continue;
            }
            try {
                const parsed = JSON.parse(trimmed);
                if (!parsed || typeof parsed !== "object") {
                    continue;
                }
                yield parsed;
            }
            catch {
                // Ignore malformed lines
            }
        }
    }
    finally {
        rl.close();
        fileStream.destroy();
    }
}
async function scanTranscriptFile(params) {
    for await (const parsed of readJsonlRecords(params.filePath)) {
        const entry = parseTranscriptEntry(parsed);
        if (!entry) {
            continue;
        }
        if (entry.usage && entry.costTotal === undefined) {
            const cost = resolveModelCostConfig({
                provider: entry.provider,
                model: entry.model,
                config: params.config,
            });
            entry.costTotal = estimateUsageCost({ usage: entry.usage, cost });
        }
        params.onEntry(entry);
    }
}
async function scanUsageFile(params) {
    await scanTranscriptFile({
        filePath: params.filePath,
        config: params.config,
        onEntry: (entry) => {
            if (!entry.usage) {
                return;
            }
            params.onEntry({
                usage: entry.usage,
                costTotal: entry.costTotal,
                costBreakdown: entry.costBreakdown,
                provider: entry.provider,
                model: entry.model,
                timestamp: entry.timestamp,
            });
        },
    });
}
export async function loadCostUsageSummary(params) {
    const now = new Date();
    let sinceTime;
    let untilTime;
    if (params?.startMs !== undefined && params?.endMs !== undefined) {
        sinceTime = params.startMs;
        untilTime = params.endMs;
    }
    else {
        // Fallback to days-based calculation for backwards compatibility
        const days = Math.max(1, Math.floor(params?.days ?? 30));
        const since = new Date(now);
        since.setDate(since.getDate() - (days - 1));
        sinceTime = since.getTime();
        untilTime = now.getTime();
    }
    const dailyMap = new Map();
    const totals = emptyTotals();
    const sessionsDir = resolveSessionTranscriptsDirForAgent(params?.agentId);
    const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    const files = (await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
        const filePath = path.join(sessionsDir, entry.name);
        const stats = await fs.promises.stat(filePath).catch(() => null);
        if (!stats) {
            return null;
        }
        // Include file if it was modified after our start time
        if (stats.mtimeMs < sinceTime) {
            return null;
        }
        return filePath;
    }))).filter((filePath) => Boolean(filePath));
    for (const filePath of files) {
        await scanUsageFile({
            filePath,
            config: params?.config,
            onEntry: (entry) => {
                const ts = entry.timestamp?.getTime();
                if (!ts || ts < sinceTime || ts > untilTime) {
                    return;
                }
                const dayKey = formatDayKey(entry.timestamp ?? now);
                const bucket = dailyMap.get(dayKey) ?? emptyTotals();
                applyUsageTotals(bucket, entry.usage);
                if (entry.costBreakdown?.total !== undefined) {
                    applyCostBreakdown(bucket, entry.costBreakdown);
                }
                else {
                    applyCostTotal(bucket, entry.costTotal);
                }
                dailyMap.set(dayKey, bucket);
                applyUsageTotals(totals, entry.usage);
                if (entry.costBreakdown?.total !== undefined) {
                    applyCostBreakdown(totals, entry.costBreakdown);
                }
                else {
                    applyCostTotal(totals, entry.costTotal);
                }
            },
        });
    }
    const daily = Array.from(dailyMap.entries())
        .map(([date, bucket]) => Object.assign({ date }, bucket))
        .toSorted((a, b) => a.date.localeCompare(b.date));
    // Calculate days for backwards compatibility in response
    const days = Math.ceil((untilTime - sinceTime) / (24 * 60 * 60 * 1000)) + 1;
    return {
        updatedAt: Date.now(),
        days,
        daily,
        totals,
    };
}
/**
 * Scan all transcript files to discover sessions not in the session store.
 * Returns basic metadata for each discovered session.
 */
export async function discoverAllSessions(params) {
    const sessionsDir = resolveSessionTranscriptsDirForAgent(params?.agentId);
    const entries = await fs.promises.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
    const discovered = [];
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
            continue;
        }
        const filePath = path.join(sessionsDir, entry.name);
        const stats = await fs.promises.stat(filePath).catch(() => null);
        if (!stats) {
            continue;
        }
        // Filter by date range if provided
        if (params?.startMs && stats.mtimeMs < params.startMs) {
            continue;
        }
        // Do not exclude by endMs: a session can have activity in range even if it continued later.
        // Extract session ID from filename (remove .jsonl)
        const sessionId = entry.name.slice(0, -6);
        // Try to read first user message for label extraction
        let firstUserMessage;
        try {
            for await (const parsed of readJsonlRecords(filePath)) {
                try {
                    const message = parsed.message;
                    if (message?.role === "user") {
                        const content = message.content;
                        if (typeof content === "string") {
                            firstUserMessage = content.slice(0, 100);
                        }
                        else if (Array.isArray(content)) {
                            for (const block of content) {
                                if (typeof block === "object" &&
                                    block &&
                                    block.type === "text") {
                                    const text = block.text;
                                    if (typeof text === "string") {
                                        firstUserMessage = text.slice(0, 100);
                                    }
                                    break;
                                }
                            }
                        }
                        break; // Found first user message
                    }
                }
                catch {
                    // Skip malformed lines
                }
            }
        }
        catch {
            // Ignore read errors
        }
        discovered.push({
            sessionId,
            sessionFile: filePath,
            mtime: stats.mtimeMs,
            firstUserMessage,
        });
    }
    // Sort by mtime descending (most recent first)
    return discovered.toSorted((a, b) => b.mtime - a.mtime);
}
export async function loadSessionCostSummary(params) {
    const sessionFile = params.sessionFile ??
        (params.sessionId
            ? resolveSessionFilePath(params.sessionId, params.sessionEntry, {
                agentId: params.agentId,
            })
            : undefined);
    if (!sessionFile || !fs.existsSync(sessionFile)) {
        return null;
    }
    const totals = emptyTotals();
    let firstActivity;
    let lastActivity;
    const activityDatesSet = new Set();
    const dailyMap = new Map();
    const dailyMessageMap = new Map();
    const dailyLatencyMap = new Map();
    const dailyModelUsageMap = new Map();
    const messageCounts = {
        total: 0,
        user: 0,
        assistant: 0,
        toolCalls: 0,
        toolResults: 0,
        errors: 0,
    };
    const toolUsageMap = new Map();
    const modelUsageMap = new Map();
    const errorStopReasons = new Set(["error", "aborted", "timeout"]);
    const latencyValues = [];
    let lastUserTimestamp;
    const MAX_LATENCY_MS = 12 * 60 * 60 * 1000;
    await scanTranscriptFile({
        filePath: sessionFile,
        config: params.config,
        onEntry: (entry) => {
            const ts = entry.timestamp?.getTime();
            // Filter by date range if specified
            if (params.startMs !== undefined && ts !== undefined && ts < params.startMs) {
                return;
            }
            if (params.endMs !== undefined && ts !== undefined && ts > params.endMs) {
                return;
            }
            if (ts !== undefined) {
                if (!firstActivity || ts < firstActivity) {
                    firstActivity = ts;
                }
                if (!lastActivity || ts > lastActivity) {
                    lastActivity = ts;
                }
            }
            if (entry.role === "user") {
                messageCounts.user += 1;
                messageCounts.total += 1;
                if (entry.timestamp) {
                    lastUserTimestamp = entry.timestamp.getTime();
                }
            }
            if (entry.role === "assistant") {
                messageCounts.assistant += 1;
                messageCounts.total += 1;
                const ts = entry.timestamp?.getTime();
                if (ts !== undefined) {
                    const latencyMs = entry.durationMs ??
                        (lastUserTimestamp !== undefined ? Math.max(0, ts - lastUserTimestamp) : undefined);
                    if (latencyMs !== undefined &&
                        Number.isFinite(latencyMs) &&
                        latencyMs <= MAX_LATENCY_MS) {
                        latencyValues.push(latencyMs);
                        const dayKey = formatDayKey(entry.timestamp ?? new Date(ts));
                        const dailyLatencies = dailyLatencyMap.get(dayKey) ?? [];
                        dailyLatencies.push(latencyMs);
                        dailyLatencyMap.set(dayKey, dailyLatencies);
                    }
                }
            }
            if (entry.toolNames.length > 0) {
                messageCounts.toolCalls += entry.toolNames.length;
                for (const name of entry.toolNames) {
                    toolUsageMap.set(name, (toolUsageMap.get(name) ?? 0) + 1);
                }
            }
            if (entry.toolResultCounts.total > 0) {
                messageCounts.toolResults += entry.toolResultCounts.total;
                messageCounts.errors += entry.toolResultCounts.errors;
            }
            if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
                messageCounts.errors += 1;
            }
            if (entry.timestamp) {
                const dayKey = formatDayKey(entry.timestamp);
                activityDatesSet.add(dayKey);
                const daily = dailyMessageMap.get(dayKey) ?? {
                    date: dayKey,
                    total: 0,
                    user: 0,
                    assistant: 0,
                    toolCalls: 0,
                    toolResults: 0,
                    errors: 0,
                };
                daily.total += entry.role === "user" || entry.role === "assistant" ? 1 : 0;
                if (entry.role === "user") {
                    daily.user += 1;
                }
                else if (entry.role === "assistant") {
                    daily.assistant += 1;
                }
                daily.toolCalls += entry.toolNames.length;
                daily.toolResults += entry.toolResultCounts.total;
                daily.errors += entry.toolResultCounts.errors;
                if (entry.stopReason && errorStopReasons.has(entry.stopReason)) {
                    daily.errors += 1;
                }
                dailyMessageMap.set(dayKey, daily);
            }
            if (!entry.usage) {
                return;
            }
            applyUsageTotals(totals, entry.usage);
            if (entry.costBreakdown?.total !== undefined) {
                applyCostBreakdown(totals, entry.costBreakdown);
            }
            else {
                applyCostTotal(totals, entry.costTotal);
            }
            if (entry.timestamp) {
                const dayKey = formatDayKey(entry.timestamp);
                const entryTokens = (entry.usage.input ?? 0) +
                    (entry.usage.output ?? 0) +
                    (entry.usage.cacheRead ?? 0) +
                    (entry.usage.cacheWrite ?? 0);
                const entryCost = entry.costBreakdown?.total ??
                    (entry.costBreakdown
                        ? (entry.costBreakdown.input ?? 0) +
                            (entry.costBreakdown.output ?? 0) +
                            (entry.costBreakdown.cacheRead ?? 0) +
                            (entry.costBreakdown.cacheWrite ?? 0)
                        : (entry.costTotal ?? 0));
                const existing = dailyMap.get(dayKey) ?? { tokens: 0, cost: 0 };
                dailyMap.set(dayKey, {
                    tokens: existing.tokens + entryTokens,
                    cost: existing.cost + entryCost,
                });
                if (entry.provider || entry.model) {
                    const modelKey = `${dayKey}::${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
                    const dailyModel = dailyModelUsageMap.get(modelKey) ??
                        {
                            date: dayKey,
                            provider: entry.provider,
                            model: entry.model,
                            tokens: 0,
                            cost: 0,
                            count: 0,
                        };
                    dailyModel.tokens += entryTokens;
                    dailyModel.cost += entryCost;
                    dailyModel.count += 1;
                    dailyModelUsageMap.set(modelKey, dailyModel);
                }
            }
            if (entry.provider || entry.model) {
                const key = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
                const existing = modelUsageMap.get(key) ??
                    {
                        provider: entry.provider,
                        model: entry.model,
                        count: 0,
                        totals: emptyTotals(),
                    };
                existing.count += 1;
                applyUsageTotals(existing.totals, entry.usage);
                if (entry.costBreakdown?.total !== undefined) {
                    applyCostBreakdown(existing.totals, entry.costBreakdown);
                }
                else {
                    applyCostTotal(existing.totals, entry.costTotal);
                }
                modelUsageMap.set(key, existing);
            }
        },
    });
    // Convert daily map to sorted array
    const dailyBreakdown = Array.from(dailyMap.entries())
        .map(([date, data]) => ({ date, tokens: data.tokens, cost: data.cost }))
        .toSorted((a, b) => a.date.localeCompare(b.date));
    const dailyMessageCounts = Array.from(dailyMessageMap.values()).toSorted((a, b) => a.date.localeCompare(b.date));
    const dailyLatency = Array.from(dailyLatencyMap.entries())
        .map(([date, values]) => {
        const stats = computeLatencyStats(values);
        if (!stats) {
            return null;
        }
        return { date, ...stats };
    })
        .filter((entry) => Boolean(entry))
        .toSorted((a, b) => a.date.localeCompare(b.date));
    const dailyModelUsage = Array.from(dailyModelUsageMap.values()).toSorted((a, b) => a.date.localeCompare(b.date) || b.cost - a.cost);
    const toolUsage = toolUsageMap.size
        ? {
            totalCalls: Array.from(toolUsageMap.values()).reduce((sum, count) => sum + count, 0),
            uniqueTools: toolUsageMap.size,
            tools: Array.from(toolUsageMap.entries())
                .map(([name, count]) => ({ name, count }))
                .toSorted((a, b) => b.count - a.count),
        }
        : undefined;
    const modelUsage = modelUsageMap.size
        ? Array.from(modelUsageMap.values()).toSorted((a, b) => {
            const costDiff = b.totals.totalCost - a.totals.totalCost;
            if (costDiff !== 0) {
                return costDiff;
            }
            return b.totals.totalTokens - a.totals.totalTokens;
        })
        : undefined;
    return {
        sessionId: params.sessionId,
        sessionFile,
        firstActivity,
        lastActivity,
        durationMs: firstActivity !== undefined && lastActivity !== undefined
            ? Math.max(0, lastActivity - firstActivity)
            : undefined,
        activityDates: Array.from(activityDatesSet).toSorted(),
        dailyBreakdown,
        dailyMessageCounts,
        dailyLatency: dailyLatency.length ? dailyLatency : undefined,
        dailyModelUsage: dailyModelUsage.length ? dailyModelUsage : undefined,
        messageCounts,
        toolUsage,
        modelUsage,
        latency: computeLatencyStats(latencyValues),
        ...totals,
    };
}
export async function loadSessionUsageTimeSeries(params) {
    const sessionFile = params.sessionFile ??
        (params.sessionId
            ? resolveSessionFilePath(params.sessionId, params.sessionEntry, {
                agentId: params.agentId,
            })
            : undefined);
    if (!sessionFile || !fs.existsSync(sessionFile)) {
        return null;
    }
    const points = [];
    let cumulativeTokens = 0;
    let cumulativeCost = 0;
    await scanUsageFile({
        filePath: sessionFile,
        config: params.config,
        onEntry: (entry) => {
            const ts = entry.timestamp?.getTime();
            if (!ts) {
                return;
            }
            const input = entry.usage.input ?? 0;
            const output = entry.usage.output ?? 0;
            const cacheRead = entry.usage.cacheRead ?? 0;
            const cacheWrite = entry.usage.cacheWrite ?? 0;
            const totalTokens = entry.usage.total ?? input + output + cacheRead + cacheWrite;
            const cost = entry.costTotal ?? 0;
            cumulativeTokens += totalTokens;
            cumulativeCost += cost;
            points.push({
                timestamp: ts,
                input,
                output,
                cacheRead,
                cacheWrite,
                totalTokens,
                cost,
                cumulativeTokens,
                cumulativeCost,
            });
        },
    });
    // Sort by timestamp
    const sortedPoints = points.toSorted((a, b) => a.timestamp - b.timestamp);
    // Optionally downsample if too many points
    const maxPoints = params.maxPoints ?? 100;
    if (sortedPoints.length > maxPoints) {
        const step = Math.ceil(sortedPoints.length / maxPoints);
        const downsampled = [];
        let downsampledCumulativeTokens = 0;
        let downsampledCumulativeCost = 0;
        for (let i = 0; i < sortedPoints.length; i += step) {
            const bucket = sortedPoints.slice(i, i + step);
            const bucketLast = bucket[bucket.length - 1];
            if (!bucketLast) {
                continue;
            }
            let bucketInput = 0;
            let bucketOutput = 0;
            let bucketCacheRead = 0;
            let bucketCacheWrite = 0;
            let bucketTotalTokens = 0;
            let bucketCost = 0;
            for (const point of bucket) {
                bucketInput += point.input;
                bucketOutput += point.output;
                bucketCacheRead += point.cacheRead;
                bucketCacheWrite += point.cacheWrite;
                bucketTotalTokens += point.totalTokens;
                bucketCost += point.cost;
            }
            downsampledCumulativeTokens += bucketTotalTokens;
            downsampledCumulativeCost += bucketCost;
            downsampled.push({
                timestamp: bucketLast.timestamp,
                input: bucketInput,
                output: bucketOutput,
                cacheRead: bucketCacheRead,
                cacheWrite: bucketCacheWrite,
                totalTokens: bucketTotalTokens,
                cost: bucketCost,
                cumulativeTokens: downsampledCumulativeTokens,
                cumulativeCost: downsampledCumulativeCost,
            });
        }
        return { sessionId: params.sessionId, points: downsampled };
    }
    return { sessionId: params.sessionId, points: sortedPoints };
}
export async function loadSessionLogs(params) {
    const sessionFile = params.sessionFile ??
        (params.sessionId
            ? resolveSessionFilePath(params.sessionId, params.sessionEntry, {
                agentId: params.agentId,
            })
            : undefined);
    if (!sessionFile || !fs.existsSync(sessionFile)) {
        return null;
    }
    const logs = [];
    const limit = params.limit ?? 50;
    for await (const parsed of readJsonlRecords(sessionFile)) {
        try {
            const message = parsed.message;
            if (!message) {
                continue;
            }
            const role = message.role;
            if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "toolResult") {
                continue;
            }
            const contentParts = [];
            const rawToolName = message.toolName ?? message.tool_name ?? message.name ?? message.tool;
            const toolName = typeof rawToolName === "string" && rawToolName.trim() ? rawToolName.trim() : undefined;
            if (role === "tool" || role === "toolResult") {
                contentParts.push(`[Tool: ${toolName ?? "tool"}]`);
                contentParts.push("[Tool Result]");
            }
            // Extract content
            const rawContent = message.content;
            if (typeof rawContent === "string") {
                contentParts.push(rawContent);
            }
            else if (Array.isArray(rawContent)) {
                // Handle content blocks (text, tool_use, etc.)
                const contentText = rawContent
                    .map((block) => {
                    if (typeof block === "string") {
                        return block;
                    }
                    const b = block;
                    if (b.type === "text" && typeof b.text === "string") {
                        return b.text;
                    }
                    if (b.type === "tool_use") {
                        const name = typeof b.name === "string" ? b.name : "unknown";
                        return `[Tool: ${name}]`;
                    }
                    if (b.type === "tool_result") {
                        return `[Tool Result]`;
                    }
                    return "";
                })
                    .filter(Boolean)
                    .join("\n");
                if (contentText) {
                    contentParts.push(contentText);
                }
            }
            // OpenAI-style tool calls stored outside the content array.
            const rawToolCalls = message.tool_calls ?? message.toolCalls ?? message.function_call ?? message.functionCall;
            const toolCalls = Array.isArray(rawToolCalls)
                ? rawToolCalls
                : rawToolCalls
                    ? [rawToolCalls]
                    : [];
            if (toolCalls.length > 0) {
                for (const call of toolCalls) {
                    const callObj = call;
                    const directName = typeof callObj.name === "string" ? callObj.name : undefined;
                    const fn = callObj.function;
                    const fnName = typeof fn?.name === "string" ? fn.name : undefined;
                    const name = directName ?? fnName ?? "unknown";
                    contentParts.push(`[Tool: ${name}]`);
                }
            }
            let content = contentParts.join("\n").trim();
            if (!content) {
                continue;
            }
            content = stripInboundMetadata(content);
            if (role === "user") {
                content = stripMessageIdHints(stripEnvelope(content)).trim();
            }
            if (!content) {
                continue;
            }
            // Truncate very long content
            const maxLen = 2000;
            if (content.length > maxLen) {
                content = content.slice(0, maxLen) + "…";
            }
            // Get timestamp
            let timestamp = 0;
            if (typeof parsed.timestamp === "string") {
                timestamp = new Date(parsed.timestamp).getTime();
            }
            else if (typeof message.timestamp === "number") {
                timestamp = message.timestamp;
            }
            // Get usage for assistant messages
            let tokens;
            let cost;
            if (role === "assistant") {
                const usageRaw = message.usage;
                const usage = normalizeUsage(usageRaw);
                if (usage) {
                    tokens =
                        usage.total ??
                            (usage.input ?? 0) +
                                (usage.output ?? 0) +
                                (usage.cacheRead ?? 0) +
                                (usage.cacheWrite ?? 0);
                    const breakdown = extractCostBreakdown(usageRaw);
                    if (breakdown?.total !== undefined) {
                        cost = breakdown.total;
                    }
                    else {
                        const costConfig = resolveModelCostConfig({
                            provider: message.provider,
                            model: message.model,
                            config: params.config,
                        });
                        cost = estimateUsageCost({ usage, cost: costConfig });
                    }
                }
            }
            logs.push({
                timestamp,
                role,
                content,
                tokens,
                cost,
            });
        }
        catch {
            // Ignore malformed lines
        }
    }
    // Sort by timestamp and limit
    const sortedLogs = logs.toSorted((a, b) => a.timestamp - b.timestamp);
    // Return most recent logs
    if (sortedLogs.length > limit) {
        return sortedLogs.slice(-limit);
    }
    return sortedLogs;
}
