import fs from "node:fs";
import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveModelAuthMode } from "../agents/model-auth.js";
import { buildModelAliasIndex, resolveConfiguredModelRef, resolveModelRefFromString, } from "../agents/model-selection.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox.js";
import { derivePromptTokens, normalizeUsage } from "../agents/usage.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import { isCommandFlagEnabled } from "../config/commands.js";
import { resolveMainSessionKey, resolveSessionFilePath, resolveSessionFilePathOptions, } from "../config/sessions.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { resolveCommitHash } from "../infra/git-commit.js";
import { listPluginCommands } from "../plugins/commands.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { getTtsMaxLength, getTtsProvider, isSummarizationEnabled, resolveTtsAutoMode, resolveTtsConfig, resolveTtsPrefsPath, } from "../tts/tts.js";
import { estimateUsageCost, formatTokenCount as formatTokenCountShared, formatUsd, resolveModelCostConfig, } from "../utils/usage-format.js";
import { VERSION } from "../version.js";
import { listChatCommands, listChatCommandsForConfig, } from "./commands-registry.js";
import { resolveActiveFallbackState } from "./fallback-state.js";
import { formatProviderModelRef, resolveSelectedAndActiveModel } from "./model-runtime.js";
export const formatTokenCount = formatTokenCountShared;
function normalizeAuthMode(value) {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }
    if (normalized === "api-key" || normalized.startsWith("api-key ")) {
        return "api-key";
    }
    if (normalized === "oauth" || normalized.startsWith("oauth ")) {
        return "oauth";
    }
    if (normalized === "token" || normalized.startsWith("token ")) {
        return "token";
    }
    if (normalized === "aws-sdk" || normalized.startsWith("aws-sdk ")) {
        return "aws-sdk";
    }
    if (normalized === "mixed" || normalized.startsWith("mixed ")) {
        return "mixed";
    }
    if (normalized === "unknown") {
        return "unknown";
    }
    return undefined;
}
function resolveRuntimeLabel(args) {
    const sessionKey = args.sessionKey?.trim();
    if (args.config && sessionKey) {
        const runtimeStatus = resolveSandboxRuntimeStatus({
            cfg: args.config,
            sessionKey,
        });
        const sandboxMode = runtimeStatus.mode ?? "off";
        if (sandboxMode === "off") {
            return "direct";
        }
        const runtime = runtimeStatus.sandboxed ? "docker" : sessionKey ? "direct" : "unknown";
        return `${runtime}/${sandboxMode}`;
    }
    const sandboxMode = args.agent?.sandbox?.mode ?? "off";
    if (sandboxMode === "off") {
        return "direct";
    }
    const sandboxed = (() => {
        if (!sessionKey) {
            return false;
        }
        if (sandboxMode === "all") {
            return true;
        }
        if (args.config) {
            return resolveSandboxRuntimeStatus({
                cfg: args.config,
                sessionKey,
            }).sandboxed;
        }
        const sessionScope = args.sessionScope ?? "per-sender";
        const mainKey = resolveMainSessionKey({
            session: { scope: sessionScope },
        });
        return sessionKey !== mainKey.trim();
    })();
    const runtime = sandboxed ? "docker" : sessionKey ? "direct" : "unknown";
    return `${runtime}/${sandboxMode}`;
}
const formatTokens = (total, contextTokens) => {
    const ctx = contextTokens ?? null;
    if (total == null) {
        const ctxLabel = ctx ? formatTokenCount(ctx) : "?";
        return `?/${ctxLabel}`;
    }
    const pct = ctx ? Math.min(999, Math.round((total / ctx) * 100)) : null;
    const totalLabel = formatTokenCount(total);
    const ctxLabel = ctx ? formatTokenCount(ctx) : "?";
    return `${totalLabel}/${ctxLabel}${pct !== null ? ` (${pct}%)` : ""}`;
};
export const formatContextUsageShort = (total, contextTokens) => `Context ${formatTokens(total, contextTokens ?? null)}`;
const formatQueueDetails = (queue) => {
    if (!queue) {
        return "";
    }
    const depth = typeof queue.depth === "number" ? `depth ${queue.depth}` : null;
    if (!queue.showDetails) {
        return depth ? ` (${depth})` : "";
    }
    const detailParts = [];
    if (depth) {
        detailParts.push(depth);
    }
    if (typeof queue.debounceMs === "number") {
        const ms = Math.max(0, Math.round(queue.debounceMs));
        const label = ms >= 1000 ? `${ms % 1000 === 0 ? ms / 1000 : (ms / 1000).toFixed(1)}s` : `${ms}ms`;
        detailParts.push(`debounce ${label}`);
    }
    if (typeof queue.cap === "number") {
        detailParts.push(`cap ${queue.cap}`);
    }
    if (queue.dropPolicy) {
        detailParts.push(`drop ${queue.dropPolicy}`);
    }
    return detailParts.length ? ` (${detailParts.join(" · ")})` : "";
};
const readUsageFromSessionLog = (sessionId, sessionEntry, agentId, sessionKey, storePath) => {
    // Transcripts are stored at the session file path (fallback: ~/.openclaw/sessions/<SessionId>.jsonl)
    if (!sessionId) {
        return undefined;
    }
    let logPath;
    try {
        const resolvedAgentId = agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
        logPath = resolveSessionFilePath(sessionId, sessionEntry, resolveSessionFilePathOptions({ agentId: resolvedAgentId, storePath }));
    }
    catch {
        return undefined;
    }
    if (!fs.existsSync(logPath)) {
        return undefined;
    }
    try {
        // Read the tail only; we only need the most recent usage entries.
        const TAIL_BYTES = 8192;
        const stat = fs.statSync(logPath);
        const offset = Math.max(0, stat.size - TAIL_BYTES);
        const buf = Buffer.alloc(Math.min(TAIL_BYTES, stat.size));
        const fd = fs.openSync(logPath, "r");
        try {
            fs.readSync(fd, buf, 0, buf.length, offset);
        }
        finally {
            fs.closeSync(fd);
        }
        const tail = buf.toString("utf-8");
        const lines = (offset > 0 ? tail.slice(tail.indexOf("\n") + 1) : tail).split(/\n+/);
        let input = 0;
        let output = 0;
        let promptTokens = 0;
        let model;
        let lastUsage;
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            try {
                const parsed = JSON.parse(line);
                const usageRaw = parsed.message?.usage ?? parsed.usage;
                const usage = normalizeUsage(usageRaw);
                if (usage) {
                    lastUsage = usage;
                }
                model = parsed.message?.model ?? parsed.model ?? model;
            }
            catch {
                // ignore bad lines (including a truncated first tail line)
            }
        }
        if (!lastUsage) {
            return undefined;
        }
        input = lastUsage.input ?? 0;
        output = lastUsage.output ?? 0;
        promptTokens = derivePromptTokens(lastUsage) ?? lastUsage.total ?? input + output;
        const total = lastUsage.total ?? promptTokens + output;
        if (promptTokens === 0 && total === 0) {
            return undefined;
        }
        return { input, output, promptTokens, total, model };
    }
    catch {
        return undefined;
    }
};
const formatUsagePair = (input, output) => {
    if (input == null && output == null) {
        return null;
    }
    const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
    const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
    return `🧮 Tokens: ${inputLabel} in / ${outputLabel} out`;
};
const formatCacheLine = (input, cacheRead, cacheWrite) => {
    if (!cacheRead && !cacheWrite) {
        return null;
    }
    if ((typeof cacheRead !== "number" || cacheRead <= 0) &&
        (typeof cacheWrite !== "number" || cacheWrite <= 0)) {
        return null;
    }
    const cachedLabel = typeof cacheRead === "number" ? formatTokenCount(cacheRead) : "0";
    const newLabel = typeof cacheWrite === "number" ? formatTokenCount(cacheWrite) : "0";
    const totalInput = (typeof cacheRead === "number" ? cacheRead : 0) +
        (typeof cacheWrite === "number" ? cacheWrite : 0) +
        (typeof input === "number" ? input : 0);
    const hitRate = totalInput > 0 && typeof cacheRead === "number"
        ? Math.round((cacheRead / totalInput) * 100)
        : 0;
    return `🗄️ Cache: ${hitRate}% hit · ${cachedLabel} cached, ${newLabel} new`;
};
const formatMediaUnderstandingLine = (decisions) => {
    if (!decisions || decisions.length === 0) {
        return null;
    }
    const parts = decisions
        .map((decision) => {
        const count = decision.attachments.length;
        const countLabel = count > 1 ? ` x${count}` : "";
        if (decision.outcome === "success") {
            const chosen = decision.attachments.find((entry) => entry.chosen)?.chosen;
            const provider = chosen?.provider?.trim();
            const model = chosen?.model?.trim();
            const modelLabel = provider ? (model ? `${provider}/${model}` : provider) : null;
            return `${decision.capability}${countLabel} ok${modelLabel ? ` (${modelLabel})` : ""}`;
        }
        if (decision.outcome === "no-attachment") {
            return `${decision.capability} none`;
        }
        if (decision.outcome === "disabled") {
            return `${decision.capability} off`;
        }
        if (decision.outcome === "scope-deny") {
            return `${decision.capability} denied`;
        }
        if (decision.outcome === "skipped") {
            const reason = decision.attachments
                .flatMap((entry) => entry.attempts.map((attempt) => attempt.reason).filter(Boolean))
                .find(Boolean);
            const shortReason = reason ? reason.split(":")[0]?.trim() : undefined;
            return `${decision.capability} skipped${shortReason ? ` (${shortReason})` : ""}`;
        }
        return null;
    })
        .filter((part) => part != null);
    if (parts.length === 0) {
        return null;
    }
    if (parts.every((part) => part.endsWith(" none"))) {
        return null;
    }
    return `📎 Media: ${parts.join(" · ")}`;
};
const formatVoiceModeLine = (config, sessionEntry) => {
    if (!config) {
        return null;
    }
    const ttsConfig = resolveTtsConfig(config);
    const prefsPath = resolveTtsPrefsPath(ttsConfig);
    const autoMode = resolveTtsAutoMode({
        config: ttsConfig,
        prefsPath,
        sessionAuto: sessionEntry?.ttsAuto,
    });
    if (autoMode === "off") {
        return null;
    }
    const provider = getTtsProvider(ttsConfig, prefsPath);
    const maxLength = getTtsMaxLength(prefsPath);
    const summarize = isSummarizationEnabled(prefsPath) ? "on" : "off";
    return `🔊 Voice: ${autoMode} · provider=${provider} · limit=${maxLength} · summary=${summarize}`;
};
export function buildStatusMessage(args) {
    const now = args.now ?? Date.now();
    const entry = args.sessionEntry;
    const selectionConfig = {
        agents: {
            defaults: args.agent ?? {},
        },
    };
    const contextConfig = args.config
        ? {
            ...args.config,
            agents: {
                ...args.config.agents,
                defaults: {
                    ...args.config.agents?.defaults,
                    ...args.agent,
                },
            },
        }
        : {
            agents: {
                defaults: args.agent ?? {},
            },
        };
    const resolved = resolveConfiguredModelRef({
        cfg: selectionConfig,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
    });
    const selectedProvider = entry?.providerOverride ?? resolved.provider ?? DEFAULT_PROVIDER;
    const selectedModel = entry?.modelOverride ?? resolved.model ?? DEFAULT_MODEL;
    const modelRefs = resolveSelectedAndActiveModel({
        selectedProvider,
        selectedModel,
        sessionEntry: entry,
    });
    let activeProvider = modelRefs.active.provider;
    let activeModel = modelRefs.active.model;
    let contextTokens = resolveContextTokensForModel({
        cfg: contextConfig,
        provider: activeProvider,
        model: activeModel,
        contextTokensOverride: entry?.contextTokens ?? args.agent?.contextTokens,
        fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
    }) ?? DEFAULT_CONTEXT_TOKENS;
    let inputTokens = entry?.inputTokens;
    let outputTokens = entry?.outputTokens;
    let cacheRead = entry?.cacheRead;
    let cacheWrite = entry?.cacheWrite;
    let totalTokens = entry?.totalTokens ?? (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0);
    // Prefer prompt-size tokens from the session transcript when it looks larger
    // (cached prompt tokens are often missing from agent meta/store).
    if (args.includeTranscriptUsage) {
        const logUsage = readUsageFromSessionLog(entry?.sessionId, entry, args.agentId, args.sessionKey, args.sessionStorePath);
        if (logUsage) {
            const candidate = logUsage.promptTokens || logUsage.total;
            if (!totalTokens || totalTokens === 0 || candidate > totalTokens) {
                totalTokens = candidate;
            }
            if (!entry?.model && logUsage.model) {
                const slashIndex = logUsage.model.indexOf("/");
                if (slashIndex > 0) {
                    const provider = logUsage.model.slice(0, slashIndex).trim();
                    const model = logUsage.model.slice(slashIndex + 1).trim();
                    if (provider && model) {
                        activeProvider = provider;
                        activeModel = model;
                    }
                }
                else {
                    activeModel = logUsage.model;
                }
            }
            if (!contextTokens && logUsage.model) {
                contextTokens =
                    resolveContextTokensForModel({
                        cfg: contextConfig,
                        model: logUsage.model,
                        fallbackContextTokens: contextTokens ?? undefined,
                    }) ?? contextTokens;
            }
            if (!inputTokens || inputTokens === 0) {
                inputTokens = logUsage.input;
            }
            if (!outputTokens || outputTokens === 0) {
                outputTokens = logUsage.output;
            }
        }
    }
    const thinkLevel = args.resolvedThink ?? args.sessionEntry?.thinkingLevel ?? args.agent?.thinkingDefault ?? "off";
    const verboseLevel = args.resolvedVerbose ?? args.sessionEntry?.verboseLevel ?? args.agent?.verboseDefault ?? "off";
    const reasoningLevel = args.resolvedReasoning ?? args.sessionEntry?.reasoningLevel ?? "off";
    const elevatedLevel = args.resolvedElevated ??
        args.sessionEntry?.elevatedLevel ??
        args.agent?.elevatedDefault ??
        "on";
    const runtime = { label: resolveRuntimeLabel(args) };
    const updatedAt = entry?.updatedAt;
    const sessionLine = [
        `Session: ${args.sessionKey ?? "unknown"}`,
        typeof updatedAt === "number" ? `updated ${formatTimeAgo(now - updatedAt)}` : "no activity",
    ]
        .filter(Boolean)
        .join(" • ");
    const isGroupSession = entry?.chatType === "group" ||
        entry?.chatType === "channel" ||
        Boolean(args.sessionKey?.includes(":group:")) ||
        Boolean(args.sessionKey?.includes(":channel:"));
    const groupActivationValue = isGroupSession
        ? (args.groupActivation ?? entry?.groupActivation ?? "mention")
        : undefined;
    const contextLine = [
        `Context: ${formatTokens(totalTokens, contextTokens ?? null)}`,
        `🧹 Compactions: ${entry?.compactionCount ?? 0}`,
    ]
        .filter(Boolean)
        .join(" · ");
    const queueMode = args.queue?.mode ?? "unknown";
    const queueDetails = formatQueueDetails(args.queue);
    const verboseLabel = verboseLevel === "full" ? "verbose:full" : verboseLevel === "on" ? "verbose" : null;
    const elevatedLabel = elevatedLevel && elevatedLevel !== "off"
        ? elevatedLevel === "on"
            ? "elevated"
            : `elevated:${elevatedLevel}`
        : null;
    const optionParts = [
        `Runtime: ${runtime.label}`,
        `Think: ${thinkLevel}`,
        verboseLabel,
        reasoningLevel !== "off" ? `Reasoning: ${reasoningLevel}` : null,
        elevatedLabel,
    ];
    const optionsLine = optionParts.filter(Boolean).join(" · ");
    const activationParts = [
        groupActivationValue ? `👥 Activation: ${groupActivationValue}` : null,
        `🪢 Queue: ${queueMode}${queueDetails}`,
    ];
    const activationLine = activationParts.filter(Boolean).join(" · ");
    const selectedAuthMode = normalizeAuthMode(args.modelAuth) ?? resolveModelAuthMode(selectedProvider, args.config);
    const selectedAuthLabelValue = args.modelAuth ??
        (selectedAuthMode && selectedAuthMode !== "unknown" ? selectedAuthMode : undefined);
    const activeAuthMode = normalizeAuthMode(args.activeModelAuth) ?? resolveModelAuthMode(activeProvider, args.config);
    const activeAuthLabelValue = args.activeModelAuth ??
        (activeAuthMode && activeAuthMode !== "unknown" ? activeAuthMode : undefined);
    const selectedModelLabel = modelRefs.selected.label || "unknown";
    const activeModelLabel = formatProviderModelRef(activeProvider, activeModel) || "unknown";
    const fallbackState = resolveActiveFallbackState({
        selectedModelRef: selectedModelLabel,
        activeModelRef: activeModelLabel,
        state: entry,
    });
    const effectiveCostAuthMode = fallbackState.active
        ? activeAuthMode
        : (selectedAuthMode ?? activeAuthMode);
    const showCost = effectiveCostAuthMode === "api-key" || effectiveCostAuthMode === "mixed";
    const costConfig = showCost
        ? resolveModelCostConfig({
            provider: activeProvider,
            model: activeModel,
            config: args.config,
        })
        : undefined;
    const hasUsage = typeof inputTokens === "number" || typeof outputTokens === "number";
    const cost = showCost && hasUsage
        ? estimateUsageCost({
            usage: {
                input: inputTokens ?? undefined,
                output: outputTokens ?? undefined,
            },
            cost: costConfig,
        })
        : undefined;
    const costLabel = showCost && hasUsage ? formatUsd(cost) : undefined;
    const selectedAuthLabel = selectedAuthLabelValue ? ` · 🔑 ${selectedAuthLabelValue}` : "";
    const channelModelNote = (() => {
        if (!args.config || !entry) {
            return undefined;
        }
        if (entry.modelOverride?.trim() || entry.providerOverride?.trim()) {
            return undefined;
        }
        const channelOverride = resolveChannelModelOverride({
            cfg: args.config,
            channel: entry.channel ?? entry.origin?.provider,
            groupId: entry.groupId,
            groupChannel: entry.groupChannel,
            groupSubject: entry.subject,
            parentSessionKey: args.parentSessionKey,
        });
        if (!channelOverride) {
            return undefined;
        }
        const aliasIndex = buildModelAliasIndex({
            cfg: args.config,
            defaultProvider: DEFAULT_PROVIDER,
        });
        const resolvedOverride = resolveModelRefFromString({
            raw: channelOverride.model,
            defaultProvider: DEFAULT_PROVIDER,
            aliasIndex,
        });
        if (!resolvedOverride) {
            return undefined;
        }
        if (resolvedOverride.ref.provider !== selectedProvider ||
            resolvedOverride.ref.model !== selectedModel) {
            return undefined;
        }
        return "channel override";
    })();
    const modelNote = channelModelNote ? ` · ${channelModelNote}` : "";
    const modelLine = `🧠 Model: ${selectedModelLabel}${selectedAuthLabel}${modelNote}`;
    const showFallbackAuth = activeAuthLabelValue && activeAuthLabelValue !== selectedAuthLabelValue;
    const fallbackLine = fallbackState.active
        ? `↪️ Fallback: ${activeModelLabel}${showFallbackAuth ? ` · 🔑 ${activeAuthLabelValue}` : ""} (${fallbackState.reason ?? "selected model unavailable"})`
        : null;
    const commit = resolveCommitHash();
    const versionLine = `🦞 OpenClaw ${VERSION}${commit ? ` (${commit})` : ""}`;
    const usagePair = formatUsagePair(inputTokens, outputTokens);
    const cacheLine = formatCacheLine(inputTokens, cacheRead, cacheWrite);
    const costLine = costLabel ? `💵 Cost: ${costLabel}` : null;
    const usageCostLine = usagePair && costLine ? `${usagePair} · ${costLine}` : (usagePair ?? costLine);
    const mediaLine = formatMediaUnderstandingLine(args.mediaDecisions);
    const voiceLine = formatVoiceModeLine(args.config, args.sessionEntry);
    return [
        versionLine,
        args.timeLine,
        modelLine,
        fallbackLine,
        usageCostLine,
        cacheLine,
        `📚 ${contextLine}`,
        mediaLine,
        args.usageLine,
        `🧵 ${sessionLine}`,
        args.subagentsLine,
        `⚙️ ${optionsLine}`,
        voiceLine,
        activationLine,
    ]
        .filter(Boolean)
        .join("\n");
}
const CATEGORY_LABELS = {
    session: "Session",
    options: "Options",
    status: "Status",
    management: "Management",
    media: "Media",
    tools: "Tools",
    docks: "Docks",
};
const CATEGORY_ORDER = [
    "session",
    "options",
    "status",
    "management",
    "media",
    "tools",
    "docks",
];
function groupCommandsByCategory(commands) {
    const grouped = new Map();
    for (const category of CATEGORY_ORDER) {
        grouped.set(category, []);
    }
    for (const command of commands) {
        const category = command.category ?? "tools";
        const list = grouped.get(category) ?? [];
        list.push(command);
        grouped.set(category, list);
    }
    return grouped;
}
export function buildHelpMessage(cfg) {
    const lines = ["ℹ️ Help", ""];
    lines.push("Session");
    lines.push("  /new  |  /reset  |  /compact [instructions]  |  /stop");
    lines.push("");
    const optionParts = ["/think <level>", "/model <id>", "/verbose on|off"];
    if (isCommandFlagEnabled(cfg, "config")) {
        optionParts.push("/config");
    }
    if (isCommandFlagEnabled(cfg, "debug")) {
        optionParts.push("/debug");
    }
    lines.push("Options");
    lines.push(`  ${optionParts.join("  |  ")}`);
    lines.push("");
    lines.push("Status");
    lines.push("  /status  |  /whoami  |  /context");
    lines.push("");
    lines.push("Skills");
    lines.push("  /skill <name> [input]");
    lines.push("");
    lines.push("More: /commands for full list");
    return lines.join("\n");
}
const COMMANDS_PER_PAGE = 8;
function formatCommandEntry(command) {
    const primary = command.nativeName
        ? `/${command.nativeName}`
        : command.textAliases[0]?.trim() || `/${command.key}`;
    const seen = new Set();
    const aliases = command.textAliases
        .map((alias) => alias.trim())
        .filter(Boolean)
        .filter((alias) => alias.toLowerCase() !== primary.toLowerCase())
        .filter((alias) => {
        const key = alias.toLowerCase();
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
    const aliasLabel = aliases.length ? ` (${aliases.join(", ")})` : "";
    const scopeLabel = command.scope === "text" ? " [text]" : "";
    return `${primary}${aliasLabel}${scopeLabel} - ${command.description}`;
}
function buildCommandItems(commands, pluginCommands) {
    const grouped = groupCommandsByCategory(commands);
    const items = [];
    for (const category of CATEGORY_ORDER) {
        const categoryCommands = grouped.get(category) ?? [];
        if (categoryCommands.length === 0) {
            continue;
        }
        const label = CATEGORY_LABELS[category];
        for (const command of categoryCommands) {
            items.push({ label, text: formatCommandEntry(command) });
        }
    }
    for (const command of pluginCommands) {
        const pluginLabel = command.pluginId ? ` (${command.pluginId})` : "";
        items.push({
            label: "Plugins",
            text: `/${command.name}${pluginLabel} - ${command.description}`,
        });
    }
    return items;
}
function formatCommandList(items) {
    const lines = [];
    let currentLabel = null;
    for (const item of items) {
        if (item.label !== currentLabel) {
            if (lines.length > 0) {
                lines.push("");
            }
            lines.push(item.label);
            currentLabel = item.label;
        }
        lines.push(`  ${item.text}`);
    }
    return lines.join("\n");
}
export function buildCommandsMessage(cfg, skillCommands, options) {
    const result = buildCommandsMessagePaginated(cfg, skillCommands, options);
    return result.text;
}
export function buildCommandsMessagePaginated(cfg, skillCommands, options) {
    const page = Math.max(1, options?.page ?? 1);
    const surface = options?.surface?.toLowerCase();
    const isTelegram = surface === "telegram";
    const commands = cfg
        ? listChatCommandsForConfig(cfg, { skillCommands })
        : listChatCommands({ skillCommands });
    const pluginCommands = listPluginCommands();
    const items = buildCommandItems(commands, pluginCommands);
    if (!isTelegram) {
        const lines = ["ℹ️ Slash commands", ""];
        lines.push(formatCommandList(items));
        return {
            text: lines.join("\n").trim(),
            totalPages: 1,
            currentPage: 1,
            hasNext: false,
            hasPrev: false,
        };
    }
    const totalCommands = items.length;
    const totalPages = Math.max(1, Math.ceil(totalCommands / COMMANDS_PER_PAGE));
    const currentPage = Math.min(page, totalPages);
    const startIndex = (currentPage - 1) * COMMANDS_PER_PAGE;
    const endIndex = startIndex + COMMANDS_PER_PAGE;
    const pageItems = items.slice(startIndex, endIndex);
    const lines = [`ℹ️ Commands (${currentPage}/${totalPages})`, ""];
    lines.push(formatCommandList(pageItems));
    return {
        text: lines.join("\n").trim(),
        totalPages,
        currentPage,
        hasNext: currentPage < totalPages,
        hasPrev: currentPage > 1,
    };
}
