import { enqueueSystemEvent } from "../../infra/system-events.js";
import { isDirectiveOnly } from "./directive-handling.directive-only.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
let commandsStatusPromise = null;
let directiveLevelsPromise = null;
let directiveImplPromise = null;
let directiveFastLanePromise = null;
let directivePersistPromise = null;
function loadCommandsStatus() {
    commandsStatusPromise ??= import("./commands-status.runtime.js");
    return commandsStatusPromise;
}
function loadDirectiveLevels() {
    directiveLevelsPromise ??= import("./directive-handling.levels.js");
    return directiveLevelsPromise;
}
function loadDirectiveImpl() {
    directiveImplPromise ??= import("./directive-handling.impl.js");
    return directiveImplPromise;
}
function loadDirectiveFastLane() {
    directiveFastLanePromise ??= import("./directive-handling.fast-lane.js");
    return directiveFastLanePromise;
}
function loadDirectivePersist() {
    directivePersistPromise ??= import("./directive-handling.persist.runtime.js");
    return directivePersistPromise;
}
function hasOnlyModelDirective(directives) {
    return (directives.hasModelDirective &&
        !directives.hasThinkDirective &&
        !directives.hasFastDirective &&
        !directives.hasVerboseDirective &&
        !directives.hasTraceDirective &&
        !directives.hasReasoningDirective &&
        !directives.hasElevatedDirective &&
        !directives.hasExecDirective &&
        !directives.hasQueueDirective &&
        !directives.hasStatusDirective);
}
export async function applyInlineDirectiveOverrides(params) {
    const { ctx, cfg, agentId, agentDir, agentCfg, agentEntry, sessionEntry, sessionStore, sessionKey, storePath, sessionScope, isGroup, allowTextCommands, command, messageProviderKey, elevatedEnabled, elevatedAllowed, elevatedFailures, defaultProvider, defaultModel, aliasIndex, modelState, initialModelLabel, formatModelSwitchEvent, resolvedElevatedLevel, defaultActivation, typing, effectiveModelDirective, } = params;
    let { directives } = params;
    let { provider, model } = params;
    let { contextTokens } = params;
    const directiveModelState = {
        allowedModelKeys: modelState.allowedModelKeys,
        allowedModelCatalog: modelState.allowedModelCatalog,
        resetModelOverride: modelState.resetModelOverride,
    };
    const createDirectiveHandlingBase = () => ({
        cfg,
        directives,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        elevatedEnabled,
        elevatedAllowed,
        elevatedFailures,
        messageProviderKey,
        defaultProvider,
        defaultModel,
        aliasIndex,
        ...directiveModelState,
        provider,
        model,
        initialModelLabel,
        formatModelSwitchEvent,
    });
    let directiveAck;
    if (modelState.resetModelOverride) {
        enqueueSystemEvent(`Model override not allowed for this agent; reverted to ${initialModelLabel}.`, {
            sessionKey,
            contextKey: `model:reset:${initialModelLabel}`,
        });
    }
    if (!command.isAuthorizedSender) {
        directives = clearInlineDirectives(directives.cleaned);
    }
    const hasAnyDirective = directives.hasThinkDirective ||
        directives.hasFastDirective ||
        directives.hasVerboseDirective ||
        directives.hasTraceDirective ||
        directives.hasReasoningDirective ||
        directives.hasElevatedDirective ||
        directives.hasExecDirective ||
        directives.hasModelDirective ||
        directives.hasQueueDirective ||
        directives.hasStatusDirective;
    if (!hasAnyDirective && !modelState.resetModelOverride) {
        return {
            kind: "continue",
            directives,
            provider,
            model,
            contextTokens,
        };
    }
    const directivePersistenceContext = {
        directives,
        effectiveModelDirective,
        cfg,
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        elevatedEnabled,
        elevatedAllowed,
        defaultProvider,
        defaultModel,
        aliasIndex,
        allowedModelKeys: modelState.allowedModelKeys,
        initialModelLabel,
        formatModelSwitchEvent,
        agentCfg,
        messageProvider: ctx.Provider,
        surface: ctx.Surface,
        gatewayClientScopes: ctx.GatewayClientScopes,
        senderIsOwner: command.senderIsOwner,
    };
    if (isDirectiveOnly({
        directives,
        cleanedBody: directives.cleaned,
        ctx,
        cfg,
        agentId,
        isGroup,
    })) {
        if (!command.isAuthorizedSender) {
            typing.cleanup();
            return { kind: "reply", reply: undefined };
        }
        if (hasOnlyModelDirective(directives) && effectiveModelDirective) {
            const modelResolution = resolveModelSelectionFromDirective({
                directives: {
                    ...directives,
                    rawModelDirective: effectiveModelDirective,
                },
                cfg,
                agentDir,
                defaultProvider,
                defaultModel,
                aliasIndex,
                allowedModelKeys: modelState.allowedModelKeys,
                allowedModelCatalog: modelState.allowedModelCatalog,
                provider,
            });
            if (modelResolution.errorText) {
                typing.cleanup();
                return { kind: "reply", reply: { text: modelResolution.errorText } };
            }
            const modelSelection = modelResolution.modelSelection;
            if (modelSelection) {
                const persisted = await (await loadDirectivePersist()).persistInlineDirectives({
                    ...directivePersistenceContext,
                    provider,
                    model,
                    markLiveSwitchPending: true,
                });
                const label = `${modelSelection.provider}/${modelSelection.model}`;
                const labelWithAlias = modelSelection.alias ? `${modelSelection.alias} (${label})` : label;
                const parts = [
                    persisted.thinkingRemap
                        ? `Thinking level set to ${persisted.thinkingRemap.to} (${persisted.thinkingRemap.from} not supported for ${persisted.thinkingRemap.provider}/${persisted.thinkingRemap.model}).`
                        : undefined,
                    modelSelection.isDefault
                        ? `Model reset to default (${labelWithAlias}).`
                        : `Model set to ${labelWithAlias}.`,
                    modelResolution.profileOverride
                        ? `Auth profile set to ${modelResolution.profileOverride}.`
                        : undefined,
                ].filter(Boolean);
                typing.cleanup();
                return { kind: "reply", reply: { text: parts.join(" ") } };
            }
        }
        const { currentThinkLevel: resolvedDefaultThinkLevel, currentFastMode, currentVerboseLevel, currentReasoningLevel, currentElevatedLevel, } = await (await loadDirectiveLevels()).resolveCurrentDirectiveLevels({
            sessionEntry,
            agentEntry,
            agentCfg,
            resolveDefaultThinkingLevel: () => modelState.resolveDefaultThinkingLevel(),
        });
        const currentThinkLevel = resolvedDefaultThinkLevel;
        const directiveReply = await (await loadDirectiveImpl()).handleDirectiveOnly({
            ...createDirectiveHandlingBase(),
            currentThinkLevel,
            currentFastMode,
            currentVerboseLevel,
            currentReasoningLevel,
            currentElevatedLevel,
            ctx,
            messageProvider: ctx.Provider,
            surface: ctx.Surface,
            gatewayClientScopes: ctx.GatewayClientScopes,
            senderIsOwner: command.senderIsOwner,
        });
        let statusReply;
        if (directives.hasStatusDirective && allowTextCommands && command.isAuthorizedSender) {
            const { buildStatusReply } = await loadCommandsStatus();
            const targetSessionEntry = sessionStore[sessionKey] ?? sessionEntry;
            statusReply = await buildStatusReply({
                cfg,
                command,
                sessionEntry: targetSessionEntry,
                sessionKey,
                parentSessionKey: targetSessionEntry?.parentSessionKey ?? ctx.ParentSessionKey,
                sessionScope,
                storePath,
                provider,
                model,
                contextTokens,
                resolvedThinkLevel: resolvedDefaultThinkLevel,
                resolvedVerboseLevel: currentVerboseLevel ?? "off",
                resolvedReasoningLevel: currentReasoningLevel ?? "off",
                resolvedElevatedLevel,
                resolveDefaultThinkingLevel: async () => resolvedDefaultThinkLevel,
                isGroup,
                defaultGroupActivation: defaultActivation,
                mediaDecisions: ctx.MediaUnderstandingDecisions,
            });
        }
        typing.cleanup();
        if (statusReply?.text && directiveReply?.text) {
            return {
                kind: "reply",
                reply: { text: `${directiveReply.text}\n${statusReply.text}` },
            };
        }
        return { kind: "reply", reply: statusReply ?? directiveReply };
    }
    if (hasAnyDirective && command.isAuthorizedSender) {
        const fastLane = await (await loadDirectiveFastLane()).applyInlineDirectivesFastLane({
            directives,
            commandAuthorized: command.isAuthorizedSender,
            senderIsOwner: command.senderIsOwner,
            ctx,
            cfg,
            agentId,
            isGroup,
            sessionEntry,
            sessionStore,
            sessionKey,
            storePath,
            elevatedEnabled,
            elevatedAllowed,
            elevatedFailures,
            messageProviderKey,
            defaultProvider,
            defaultModel,
            aliasIndex,
            ...directiveModelState,
            provider,
            model,
            initialModelLabel,
            formatModelSwitchEvent,
            agentCfg,
            modelState: {
                resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
                ...directiveModelState,
            },
        });
        directiveAck = fastLane.directiveAck;
        provider = fastLane.provider;
        model = fastLane.model;
    }
    const persisted = await (await loadDirectivePersist()).persistInlineDirectives({
        ...directivePersistenceContext,
        provider,
        model,
    });
    provider = persisted.provider;
    model = persisted.model;
    contextTokens = persisted.contextTokens;
    const perMessageQueueMode = directives.hasQueueDirective && !directives.queueReset ? directives.queueMode : undefined;
    const perMessageQueueOptions = directives.hasQueueDirective && !directives.queueReset
        ? {
            debounceMs: directives.debounceMs,
            cap: directives.cap,
            dropPolicy: directives.dropPolicy,
        }
        : undefined;
    return {
        kind: "continue",
        directives,
        provider,
        model,
        contextTokens,
        directiveAck,
        perMessageQueueMode,
        perMessageQueueOptions,
    };
}
