import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { formatBtwTextForExternalDelivery, isRenderablePayload, shouldSuppressReasoningPayload, } from "../../auto-reply/reply/reply-payloads.js";
import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import { hasInteractiveReplyBlocks, hasMessagePresentationBlocks, hasReplyChannelData, hasReplyPayloadContent, } from "../../interactive/payload.js";
import { resolveSilentReplyRewriteText, } from "../../shared/silent-reply-policy.js";
import { resolvePendingSpawnedChildren } from "./pending-spawn-query.js";
function isSuppressedRelayStatusText(text) {
    const normalized = text.trim();
    if (!normalized) {
        return false;
    }
    if (/^no channel reply\.?$/i.test(normalized)) {
        return true;
    }
    if (/^replied in-thread\.?$/i.test(normalized)) {
        return true;
    }
    if (/^replied in #[-\w]+\.?$/i.test(normalized)) {
        return true;
    }
    // Prevent relay housekeeping text from leaking into user-visible channels.
    if (/^updated\s+\[[^\]]*wiki\/[^\]]+\](?:\([^)]+\))?(?:\s+with\b[\s\S]*)?(?:\.\s*)?(?:no channel reply\.?)?$/i.test(normalized)) {
        return true;
    }
    return false;
}
function mergeMediaUrls(...lists) {
    const seen = new Set();
    const merged = [];
    for (const list of lists) {
        if (!list) {
            continue;
        }
        for (const entry of list) {
            const trimmed = entry?.trim();
            if (!trimmed) {
                continue;
            }
            if (seen.has(trimmed)) {
                continue;
            }
            seen.add(trimmed);
            merged.push(trimmed);
        }
    }
    return merged;
}
function createOutboundPayloadPlanEntry(payload) {
    if (shouldSuppressReasoningPayload(payload)) {
        return null;
    }
    const parsed = parseReplyDirectives(payload.text ?? "");
    const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
    const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrl;
    const mergedMedia = mergeMediaUrls(explicitMediaUrls, explicitMediaUrl ? [explicitMediaUrl] : undefined);
    const parsedText = parsed.text ?? "";
    if (isSuppressedRelayStatusText(parsedText) && mergedMedia.length === 0) {
        return null;
    }
    const isSilent = parsed.isSilent && mergedMedia.length === 0;
    const hasMultipleMedia = (explicitMediaUrls?.length ?? 0) > 1;
    const resolvedMediaUrl = hasMultipleMedia ? undefined : explicitMediaUrl;
    const normalizedPayload = {
        ...payload,
        text: formatBtwTextForExternalDelivery({
            ...payload,
            text: parsedText,
        }) ?? "",
        mediaUrls: mergedMedia.length ? mergedMedia : undefined,
        mediaUrl: resolvedMediaUrl,
        replyToId: payload.replyToId ?? parsed.replyToId,
        replyToTag: payload.replyToTag || parsed.replyToTag,
        replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
        audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
    };
    if (!isRenderablePayload(normalizedPayload) && !isSilent) {
        return null;
    }
    const hasChannelData = hasReplyChannelData(normalizedPayload.channelData);
    return {
        payload: normalizedPayload,
        hasPresentation: hasMessagePresentationBlocks(normalizedPayload.presentation),
        hasInteractive: hasInteractiveReplyBlocks(normalizedPayload.interactive),
        hasChannelData,
        isSilent,
    };
}
export function createOutboundPayloadPlan(payloads, context = {}) {
    // Intentionally scoped to channel-agnostic normalization and projection inputs.
    // Transport concerns (queueing, hooks, retries), channel transforms, and
    // heartbeat-specific token semantics remain outside this plan boundary.
    const resolvedSilentReplySettings = resolveSilentReplySettings({
        cfg: context.cfg,
        sessionKey: context.sessionKey,
        surface: context.surface,
        conversationType: context.conversationType,
    });
    const hasPendingSpawnedChildren = context.hasPendingSpawnedChildren ?? resolvePendingSpawnedChildren(context.sessionKey);
    const prepared = [];
    for (const payload of payloads) {
        const entry = createOutboundPayloadPlanEntry(payload);
        if (!entry) {
            continue;
        }
        prepared.push(entry);
    }
    const hasVisibleNonSilentContent = prepared.some((entry) => {
        if (entry.isSilent) {
            return false;
        }
        const parts = resolveSendableOutboundReplyParts(entry.payload);
        return hasReplyPayloadContent({ ...entry.payload, text: parts.text, mediaUrls: parts.mediaUrls }, { hasChannelData: entry.hasChannelData });
    });
    const plan = [];
    for (const entry of prepared) {
        if (!entry.isSilent) {
            plan.push({
                payload: entry.payload,
                parts: resolveSendableOutboundReplyParts(entry.payload),
                hasPresentation: entry.hasPresentation,
                hasInteractive: entry.hasInteractive,
                hasChannelData: entry.hasChannelData,
            });
            continue;
        }
        if (hasVisibleNonSilentContent ||
            resolvedSilentReplySettings.policy === "allow" ||
            hasPendingSpawnedChildren) {
            continue;
        }
        if (!resolvedSilentReplySettings.rewrite) {
            const visibleSilentPayload = {
                ...entry.payload,
                text: entry.payload.text?.trim() || "NO_REPLY",
            };
            if (!isRenderablePayload(visibleSilentPayload)) {
                continue;
            }
            plan.push({
                payload: visibleSilentPayload,
                parts: resolveSendableOutboundReplyParts(visibleSilentPayload),
                hasPresentation: entry.hasPresentation,
                hasInteractive: entry.hasInteractive,
                hasChannelData: entry.hasChannelData,
            });
            continue;
        }
        const visibleSilentPayload = {
            ...entry.payload,
            text: resolveSilentReplyRewriteText({
                seed: `${context.sessionKey ?? context.surface ?? "silent-reply"}:${entry.payload.text ?? ""}`,
            }),
        };
        if (!isRenderablePayload(visibleSilentPayload)) {
            continue;
        }
        plan.push({
            payload: visibleSilentPayload,
            parts: resolveSendableOutboundReplyParts(visibleSilentPayload),
            hasPresentation: entry.hasPresentation,
            hasInteractive: entry.hasInteractive,
            hasChannelData: entry.hasChannelData,
        });
    }
    return plan;
}
export function projectOutboundPayloadPlanForDelivery(plan) {
    return plan.map((entry) => entry.payload);
}
export function projectOutboundPayloadPlanForOutbound(plan) {
    const normalizedPayloads = [];
    for (const entry of plan) {
        const payload = entry.payload;
        const text = entry.parts.text;
        if (!hasReplyPayloadContent({ ...payload, text, mediaUrls: entry.parts.mediaUrls }, { hasChannelData: entry.hasChannelData })) {
            continue;
        }
        normalizedPayloads.push({
            text,
            mediaUrls: entry.parts.mediaUrls,
            audioAsVoice: payload.audioAsVoice === true ? true : undefined,
            ...(entry.hasPresentation ? { presentation: payload.presentation } : {}),
            ...(payload.delivery ? { delivery: payload.delivery } : {}),
            ...(entry.hasInteractive ? { interactive: payload.interactive } : {}),
            ...(entry.hasChannelData ? { channelData: payload.channelData } : {}),
        });
    }
    return normalizedPayloads;
}
export function projectOutboundPayloadPlanForJson(plan) {
    const normalized = [];
    for (const entry of plan) {
        const payload = entry.payload;
        normalized.push({
            text: entry.parts.text,
            mediaUrl: payload.mediaUrl ?? null,
            mediaUrls: entry.parts.mediaUrls.length ? entry.parts.mediaUrls : undefined,
            audioAsVoice: payload.audioAsVoice === true ? true : undefined,
            presentation: payload.presentation,
            delivery: payload.delivery,
            interactive: payload.interactive,
            channelData: payload.channelData,
        });
    }
    return normalized;
}
export function projectOutboundPayloadPlanForMirror(plan) {
    return {
        text: plan
            .map((entry) => entry.payload.text)
            .filter((text) => Boolean(text))
            .join("\n"),
        mediaUrls: plan.flatMap((entry) => entry.parts.mediaUrls),
    };
}
export function summarizeOutboundPayloadForTransport(payload) {
    const parts = resolveSendableOutboundReplyParts(payload);
    const spokenText = payload.spokenText?.trim() ? payload.spokenText : undefined;
    return {
        text: parts.text,
        mediaUrls: parts.mediaUrls,
        audioAsVoice: payload.audioAsVoice === true ? true : undefined,
        presentation: payload.presentation,
        delivery: payload.delivery,
        interactive: payload.interactive,
        channelData: payload.channelData,
        ...(parts.text || !spokenText ? {} : { hookContent: spokenText }),
    };
}
export function normalizeReplyPayloadsForDelivery(payloads) {
    return projectOutboundPayloadPlanForDelivery(createOutboundPayloadPlan(payloads));
}
export function normalizeOutboundPayloads(payloads) {
    return projectOutboundPayloadPlanForOutbound(createOutboundPayloadPlan(payloads));
}
export function normalizeOutboundPayloadsForJson(payloads) {
    return projectOutboundPayloadPlanForJson(createOutboundPayloadPlan(payloads));
}
export function formatOutboundPayloadLog(payload) {
    const lines = [];
    if (payload.text) {
        lines.push(payload.text.trimEnd());
    }
    for (const url of payload.mediaUrls) {
        lines.push(`MEDIA:${url}`);
    }
    return lines.join("\n");
}
