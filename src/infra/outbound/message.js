import { loadConfig } from "../../config/config.js";
import { callGatewayLeastPrivilege, randomIdempotencyKey } from "../../gateway/call.js";
import { normalizePollInput } from "../../polls.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES, } from "../../utils/message-channel.js";
import { normalizeDeliverableOutboundChannel, resolveOutboundChannelPlugin, } from "./channel-resolution.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";
import { deliverOutboundPayloads, } from "./deliver.js";
import { normalizeReplyPayloadsForDelivery } from "./payloads.js";
import { buildOutboundSessionContext } from "./session-context.js";
import { resolveOutboundTarget } from "./targets.js";
async function resolveRequiredChannel(params) {
    if (params.channel?.trim()) {
        const normalized = normalizeDeliverableOutboundChannel(params.channel);
        if (!normalized) {
            throw new Error(`Unknown channel: ${params.channel}`);
        }
        return normalized;
    }
    return (await resolveMessageChannelSelection({ cfg: params.cfg })).channel;
}
function resolveRequiredPlugin(channel, cfg) {
    const plugin = resolveOutboundChannelPlugin({ channel, cfg });
    if (!plugin) {
        throw new Error(`Unknown channel: ${channel}`);
    }
    return plugin;
}
function resolveGatewayOptions(opts) {
    // Security: backend callers (tools/agents) must not accept user-controlled gateway URLs.
    // Use config-derived gateway target only.
    const url = opts?.mode === GATEWAY_CLIENT_MODES.BACKEND ||
        opts?.clientName === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT
        ? undefined
        : opts?.url;
    return {
        url,
        token: opts?.token,
        timeoutMs: typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
            ? Math.max(1, Math.floor(opts.timeoutMs))
            : 10000,
        clientName: opts?.clientName ?? GATEWAY_CLIENT_NAMES.CLI,
        clientDisplayName: opts?.clientDisplayName,
        mode: opts?.mode ?? GATEWAY_CLIENT_MODES.CLI,
    };
}
async function callMessageGateway(params) {
    const gateway = resolveGatewayOptions(params.gateway);
    return await callGatewayLeastPrivilege({
        url: gateway.url,
        token: gateway.token,
        method: params.method,
        params: params.params,
        timeoutMs: gateway.timeoutMs,
        clientName: gateway.clientName,
        clientDisplayName: gateway.clientDisplayName,
        mode: gateway.mode,
    });
}
export async function sendMessage(params) {
    const cfg = params.cfg ?? loadConfig();
    const channel = await resolveRequiredChannel({ cfg, channel: params.channel });
    const plugin = resolveRequiredPlugin(channel, cfg);
    const deliveryMode = plugin.outbound?.deliveryMode ?? "direct";
    const normalizedPayloads = normalizeReplyPayloadsForDelivery([
        {
            text: params.content,
            mediaUrl: params.mediaUrl,
            mediaUrls: params.mediaUrls,
        },
    ]);
    const mirrorText = normalizedPayloads
        .map((payload) => payload.text)
        .filter(Boolean)
        .join("\n");
    const mirrorMediaUrls = normalizedPayloads.flatMap((payload) => payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []));
    const primaryMediaUrl = mirrorMediaUrls[0] ?? params.mediaUrl ?? null;
    if (params.dryRun) {
        return {
            channel,
            to: params.to,
            via: deliveryMode === "gateway" ? "gateway" : "direct",
            mediaUrl: primaryMediaUrl,
            mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
            dryRun: true,
        };
    }
    if (deliveryMode !== "gateway") {
        const outboundChannel = channel;
        const resolvedTarget = resolveOutboundTarget({
            channel: outboundChannel,
            to: params.to,
            cfg,
            accountId: params.accountId,
            mode: "explicit",
        });
        if (!resolvedTarget.ok) {
            throw resolvedTarget.error;
        }
        const outboundSession = buildOutboundSessionContext({
            cfg,
            agentId: params.agentId,
            sessionKey: params.mirror?.sessionKey,
        });
        const results = await deliverOutboundPayloads({
            cfg,
            channel: outboundChannel,
            to: resolvedTarget.to,
            session: outboundSession,
            accountId: params.accountId,
            payloads: normalizedPayloads,
            replyToId: params.replyToId,
            threadId: params.threadId,
            gifPlayback: params.gifPlayback,
            deps: params.deps,
            bestEffort: params.bestEffort,
            abortSignal: params.abortSignal,
            silent: params.silent,
            mirror: params.mirror
                ? {
                    ...params.mirror,
                    text: mirrorText || params.content,
                    mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
                }
                : undefined,
        });
        return {
            channel,
            to: params.to,
            via: "direct",
            mediaUrl: primaryMediaUrl,
            mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
            result: results.at(-1),
        };
    }
    const result = await callMessageGateway({
        gateway: params.gateway,
        method: "send",
        params: {
            to: params.to,
            message: params.content,
            mediaUrl: params.mediaUrl,
            mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : params.mediaUrls,
            gifPlayback: params.gifPlayback,
            accountId: params.accountId,
            agentId: params.agentId,
            channel,
            sessionKey: params.mirror?.sessionKey,
            idempotencyKey: params.idempotencyKey ?? randomIdempotencyKey(),
        },
    });
    return {
        channel,
        to: params.to,
        via: "gateway",
        mediaUrl: primaryMediaUrl,
        mediaUrls: mirrorMediaUrls.length ? mirrorMediaUrls : undefined,
        result,
    };
}
export async function sendPoll(params) {
    const cfg = params.cfg ?? loadConfig();
    const channel = await resolveRequiredChannel({ cfg, channel: params.channel });
    const pollInput = {
        question: params.question,
        options: params.options,
        maxSelections: params.maxSelections,
        durationSeconds: params.durationSeconds,
        durationHours: params.durationHours,
    };
    const plugin = resolveRequiredPlugin(channel, cfg);
    const outbound = plugin?.outbound;
    if (!outbound?.sendPoll) {
        throw new Error(`Unsupported poll channel: ${channel}`);
    }
    const normalized = outbound.pollMaxOptions
        ? normalizePollInput(pollInput, { maxOptions: outbound.pollMaxOptions })
        : normalizePollInput(pollInput);
    if (params.dryRun) {
        return {
            channel,
            to: params.to,
            question: normalized.question,
            options: normalized.options,
            maxSelections: normalized.maxSelections,
            durationSeconds: normalized.durationSeconds ?? null,
            durationHours: normalized.durationHours ?? null,
            via: "gateway",
            dryRun: true,
        };
    }
    const result = await callMessageGateway({
        gateway: params.gateway,
        method: "poll",
        params: {
            to: params.to,
            question: normalized.question,
            options: normalized.options,
            maxSelections: normalized.maxSelections,
            durationSeconds: normalized.durationSeconds,
            durationHours: normalized.durationHours,
            threadId: params.threadId,
            silent: params.silent,
            isAnonymous: params.isAnonymous,
            channel,
            accountId: params.accountId,
            idempotencyKey: params.idempotencyKey ?? randomIdempotencyKey(),
        },
    });
    return {
        channel,
        to: params.to,
        question: normalized.question,
        options: normalized.options,
        maxSelections: normalized.maxSelections,
        durationSeconds: normalized.durationSeconds ?? null,
        durationHours: normalized.durationHours ?? null,
        via: "gateway",
        result,
    };
}
