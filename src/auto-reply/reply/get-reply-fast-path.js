import crypto from "node:crypto";
import { normalizeChatType } from "../../channels/chat-type.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { applyMergePatch } from "../../config/merge-patch.js";
import { resolveSessionTranscriptPath, resolveStorePath } from "../../config/sessions/paths.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { normalizeCommandBody } from "../commands-registry.js";
import { parseSoftResetCommand } from "./commands-reset-mode.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
const COMPLETE_REPLY_CONFIG_SYMBOL = Symbol.for("openclaw.reply.complete-config");
const FULL_REPLY_RUNTIME_SYMBOL = Symbol.for("openclaw.reply.full-runtime");
function isSlowReplyTestAllowed(env = process.env) {
    return (env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS === "1" || env.OPENCLAW_STRICT_FAST_REPLY_CONFIG === "0");
}
function resolveFastSessionKey(params) {
    const { ctx } = params;
    const nativeCommandTarget = ctx.CommandSource === "native" ? normalizeOptionalString(ctx.CommandTargetSessionKey) : "";
    if (nativeCommandTarget) {
        return nativeCommandTarget;
    }
    return resolveSessionKey(params.sessionScope, ctx, params.mainKey);
}
function markReplyConfigRuntimeMode(config, runtimeMode = "fast") {
    Object.defineProperty(config, FULL_REPLY_RUNTIME_SYMBOL, {
        value: runtimeMode === "full" ? true : undefined,
        configurable: true,
        enumerable: false,
    });
}
export function markCompleteReplyConfig(config, options) {
    Object.defineProperty(config, COMPLETE_REPLY_CONFIG_SYMBOL, {
        value: true,
        configurable: true,
        enumerable: false,
    });
    markReplyConfigRuntimeMode(config, options?.runtimeMode ?? "fast");
    return config;
}
export function withFastReplyConfig(config) {
    return markCompleteReplyConfig(config, { runtimeMode: "fast" });
}
export function withFullRuntimeReplyConfig(config) {
    return markCompleteReplyConfig(config, { runtimeMode: "full" });
}
export function isCompleteReplyConfig(config) {
    return Boolean(config &&
        typeof config === "object" &&
        config[COMPLETE_REPLY_CONFIG_SYMBOL] === true);
}
export function usesFullReplyRuntime(config) {
    return Boolean(config &&
        typeof config === "object" &&
        config[FULL_REPLY_RUNTIME_SYMBOL] === true);
}
export function resolveGetReplyConfig(params) {
    const { configOverride } = params;
    if (configOverride == null) {
        return params.loadConfig();
    }
    if (params.isFastTestEnv && !isCompleteReplyConfig(configOverride) && !isSlowReplyTestAllowed()) {
        throw new Error("Fast reply tests must pass with withFastReplyConfig()/markCompleteReplyConfig(); set OPENCLAW_ALLOW_SLOW_REPLY_TESTS=1 to opt out.");
    }
    if (params.isFastTestEnv && isCompleteReplyConfig(configOverride)) {
        return configOverride;
    }
    return applyMergePatch(params.loadConfig(), configOverride);
}
export function shouldUseReplyFastTestBootstrap(params) {
    return (params.isFastTestEnv &&
        isCompleteReplyConfig(params.configOverride) &&
        !usesFullReplyRuntime(params.configOverride));
}
export function shouldUseReplyFastTestRuntime(params) {
    return (params.isFastTestEnv && isCompleteReplyConfig(params.cfg) && !usesFullReplyRuntime(params.cfg));
}
export function shouldUseReplyFastDirectiveExecution(params) {
    if (!params.isFastTestBootstrap ||
        params.isGroup ||
        params.isHeartbeat ||
        params.resetTriggered) {
        return false;
    }
    return !params.triggerBodyNormalized.includes("/");
}
export function buildFastReplyCommandContext(params) {
    const { ctx, cfg, agentId, sessionKey, isGroup, triggerBodyNormalized, commandAuthorized } = params;
    const originatingChannel = normalizeOptionalLowercaseString(ctx.OriginatingChannel);
    const surface = normalizeOptionalLowercaseString(ctx.Surface ?? ctx.Provider) ?? "";
    const channel = originatingChannel ?? normalizeOptionalLowercaseString(ctx.Provider ?? surface) ?? "";
    const from = normalizeOptionalString(ctx.From ?? ctx.SenderId);
    const to = normalizeOptionalString(ctx.To ?? ctx.OriginatingTo);
    return {
        surface,
        channel,
        channelId: normalizeAnyChannelId(channel) ?? normalizeAnyChannelId(surface) ?? undefined,
        ownerList: [],
        senderIsOwner: false,
        isAuthorizedSender: commandAuthorized,
        senderId: from,
        abortKey: sessionKey ?? from ?? to,
        rawBodyNormalized: triggerBodyNormalized,
        commandBodyNormalized: normalizeCommandBody(isGroup ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId) : triggerBodyNormalized, { botUsername: ctx.BotUsername }),
        from,
        to,
    };
}
export function shouldHandleFastReplyTextCommands(params) {
    return params.commandSource === "native" || params.cfg.commands?.text !== false;
}
export function initFastReplySessionState(params) {
    const { ctx, cfg, agentId, commandAuthorized } = params;
    const sessionScope = cfg.session?.scope ?? "per-sender";
    const sessionKey = resolveFastSessionKey({
        ctx,
        sessionScope,
        mainKey: cfg.session?.mainKey,
    });
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const sessionStore = loadSessionStore(storePath, {
        skipCache: true,
    });
    const existingEntry = sessionStore[sessionKey];
    const commandSource = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "";
    const triggerBodyNormalized = stripStructuralPrefixes(commandSource).trim();
    const normalizedChatType = normalizeChatType(ctx.ChatType);
    const isGroup = normalizedChatType != null && normalizedChatType !== "direct";
    const strippedForReset = isGroup
        ? stripMentions(triggerBodyNormalized, ctx, cfg, agentId)
        : triggerBodyNormalized;
    const normalizedResetBody = normalizeCommandBody(strippedForReset, {
        botUsername: ctx.BotUsername,
    });
    const softReset = parseSoftResetCommand(normalizedResetBody);
    const resetMatch = normalizedResetBody.match(/^\/(new|reset)(?:\s|$)/i);
    const resetTriggered = Boolean(resetMatch) && !softReset.matched;
    const previousSessionEntry = resetTriggered && existingEntry ? { ...existingEntry } : undefined;
    const sessionId = !resetTriggered && existingEntry ? existingEntry.sessionId : crypto.randomUUID();
    const bodyStripped = resetTriggered
        ? normalizedResetBody.slice(resetMatch?.[0].length ?? 0).trimStart()
        : (ctx.BodyForAgent ?? ctx.Body ?? "");
    const now = Date.now();
    const sessionFile = !resetTriggered && existingEntry?.sessionFile
        ? existingEntry.sessionFile
        : resolveSessionTranscriptPath(sessionId, agentId);
    const sessionEntry = {
        ...(!resetTriggered ? existingEntry : undefined),
        sessionId,
        sessionFile,
        updatedAt: now,
        thinkingLevel: resetTriggered ? existingEntry?.thinkingLevel : existingEntry?.thinkingLevel,
        verboseLevel: resetTriggered ? existingEntry?.verboseLevel : existingEntry?.verboseLevel,
        reasoningLevel: resetTriggered ? existingEntry?.reasoningLevel : existingEntry?.reasoningLevel,
        ttsAuto: resetTriggered ? existingEntry?.ttsAuto : existingEntry?.ttsAuto,
        responseUsage: !resetTriggered ? existingEntry?.responseUsage : undefined,
        modelOverride: resetTriggered ? existingEntry?.modelOverride : existingEntry?.modelOverride,
        providerOverride: resetTriggered
            ? existingEntry?.providerOverride
            : existingEntry?.providerOverride,
        authProfileOverride: resetTriggered
            ? existingEntry?.authProfileOverride
            : existingEntry?.authProfileOverride,
        authProfileOverrideSource: resetTriggered
            ? existingEntry?.authProfileOverrideSource
            : existingEntry?.authProfileOverrideSource,
        authProfileOverrideCompactionCount: resetTriggered
            ? existingEntry?.authProfileOverrideCompactionCount
            : existingEntry?.authProfileOverrideCompactionCount,
        ...(normalizedChatType ? { chatType: normalizedChatType } : {}),
        ...(normalizeOptionalString(ctx.Provider)
            ? { channel: normalizeOptionalString(ctx.Provider) }
            : {}),
        ...(normalizeOptionalString(ctx.GroupSubject)
            ? { subject: normalizeOptionalString(ctx.GroupSubject) }
            : {}),
        ...(normalizeOptionalString(ctx.GroupChannel)
            ? { groupChannel: normalizeOptionalString(ctx.GroupChannel) }
            : {}),
    };
    sessionStore[sessionKey] = sessionEntry;
    const sessionCtx = {
        ...ctx,
        SessionKey: sessionKey,
        CommandAuthorized: commandAuthorized,
        BodyStripped: bodyStripped,
        ...(normalizedChatType ? { ChatType: normalizedChatType } : {}),
    };
    return {
        sessionCtx,
        sessionEntry,
        sessionStore,
        sessionKey,
        sessionId,
        isNewSession: resetTriggered || !existingEntry,
        resetTriggered,
        systemSent: false,
        abortedLastRun: false,
        storePath,
        sessionScope,
        groupResolution: undefined,
        isGroup,
        bodyStripped,
        triggerBodyNormalized,
        previousSessionEntry,
    };
}
