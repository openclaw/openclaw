import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import { formatErrorMessage } from "../infra/errors.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { resolveAgentOutboundIdentity } from "../infra/outbound/identity.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { getChildLogger } from "../logging.js";
import { resolveDeliveryTarget } from "./isolated-agent/delivery-target.js";
function normalizeChannel(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) {
        return undefined;
    }
    return trimmed;
}
function normalizeTo(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function normalizeAccountId(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
export function resolveCronDeliveryPlan(job) {
    const payload = job.payload.kind === "agentTurn" ? job.payload : null;
    const delivery = job.delivery;
    const hasDelivery = delivery && typeof delivery === "object";
    const rawMode = hasDelivery ? delivery.mode : undefined;
    const normalizedMode = typeof rawMode === "string" ? rawMode.trim().toLowerCase() : rawMode;
    const mode = normalizedMode === "announce"
        ? "announce"
        : normalizedMode === "webhook"
            ? "webhook"
            : normalizedMode === "none"
                ? "none"
                : normalizedMode === "deliver"
                    ? "announce"
                    : undefined;
    const payloadChannel = normalizeChannel(payload?.channel);
    const payloadTo = normalizeTo(payload?.to);
    const deliveryChannel = normalizeChannel(delivery?.channel);
    const deliveryTo = normalizeTo(delivery?.to);
    const channel = deliveryChannel ?? payloadChannel ?? "last";
    const to = deliveryTo ?? payloadTo;
    const deliveryAccountId = normalizeAccountId(delivery?.accountId);
    if (hasDelivery) {
        const resolvedMode = mode ?? "announce";
        return {
            mode: resolvedMode,
            channel: resolvedMode === "announce" ? channel : undefined,
            to,
            accountId: deliveryAccountId,
            source: "delivery",
            requested: resolvedMode === "announce",
        };
    }
    const legacyMode = payload?.deliver === true ? "explicit" : payload?.deliver === false ? "off" : "auto";
    const hasExplicitTarget = Boolean(to);
    const requested = legacyMode === "explicit" || (legacyMode === "auto" && hasExplicitTarget);
    return {
        mode: requested ? "announce" : "none",
        channel,
        to,
        source: "payload",
        requested,
    };
}
function normalizeFailureMode(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "announce" || trimmed === "webhook") {
        return trimmed;
    }
    return undefined;
}
export function resolveFailureDestination(job, globalConfig) {
    const delivery = job.delivery;
    const jobFailureDest = delivery?.failureDestination;
    const hasJobFailureDest = jobFailureDest && typeof jobFailureDest === "object";
    let channel;
    let to;
    let accountId;
    let mode;
    // Start with global config as base
    if (globalConfig) {
        channel = normalizeChannel(globalConfig.channel);
        to = normalizeTo(globalConfig.to);
        accountId = normalizeAccountId(globalConfig.accountId);
        mode = normalizeFailureMode(globalConfig.mode);
    }
    // Override with job-level values if present
    if (hasJobFailureDest) {
        const jobChannel = normalizeChannel(jobFailureDest.channel);
        const jobTo = normalizeTo(jobFailureDest.to);
        const jobAccountId = normalizeAccountId(jobFailureDest.accountId);
        const jobMode = normalizeFailureMode(jobFailureDest.mode);
        const hasJobChannelField = "channel" in jobFailureDest;
        const hasJobToField = "to" in jobFailureDest;
        const hasJobAccountIdField = "accountId" in jobFailureDest;
        // Track if 'to' was explicitly set at job level
        const jobToExplicitValue = hasJobToField && jobTo !== undefined;
        // Respect explicit clears from partial patches.
        if (hasJobChannelField) {
            channel = jobChannel;
        }
        if (hasJobToField) {
            to = jobTo;
        }
        if (hasJobAccountIdField) {
            accountId = jobAccountId;
        }
        if (jobMode !== undefined) {
            // Mode was explicitly overridden - clear inherited 'to' since URL semantics differ
            // between announce (channel recipient) and webhook (HTTP endpoint)
            // But preserve explicit 'to' that was set at job level
            // Treat undefined global mode as "announce" for comparison
            const globalMode = globalConfig?.mode ?? "announce";
            if (!jobToExplicitValue && globalMode !== jobMode) {
                to = undefined;
            }
            mode = jobMode;
        }
    }
    if (!channel && !to && !accountId && !mode) {
        return null;
    }
    const resolvedMode = mode ?? "announce";
    // Webhook mode requires a URL
    if (resolvedMode === "webhook" && !to) {
        return null;
    }
    const result = {
        mode: resolvedMode,
        channel: resolvedMode === "announce" ? (channel ?? "last") : undefined,
        to,
        accountId,
    };
    if (delivery && isSameDeliveryTarget(delivery, result)) {
        return null;
    }
    return result;
}
function isSameDeliveryTarget(delivery, failurePlan) {
    const primaryMode = delivery.mode ?? "announce";
    if (primaryMode === "none") {
        return false;
    }
    const primaryChannel = delivery.channel;
    const primaryTo = delivery.to;
    const primaryAccountId = delivery.accountId;
    if (failurePlan.mode === "webhook") {
        return primaryMode === "webhook" && primaryTo === failurePlan.to;
    }
    const primaryChannelNormalized = primaryChannel ?? "last";
    const failureChannelNormalized = failurePlan.channel ?? "last";
    return (failureChannelNormalized === primaryChannelNormalized &&
        failurePlan.to === primaryTo &&
        failurePlan.accountId === primaryAccountId);
}
const FAILURE_NOTIFICATION_TIMEOUT_MS = 30000;
const cronDeliveryLogger = getChildLogger({ subsystem: "cron-delivery" });
export async function sendFailureNotificationAnnounce(deps, cfg, agentId, jobId, target, message) {
    const resolvedTarget = await resolveDeliveryTarget(cfg, agentId, {
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
    });
    if (!resolvedTarget.ok) {
        cronDeliveryLogger.warn({ error: resolvedTarget.error.message }, "cron: failed to resolve failure destination target");
        return;
    }
    const identity = resolveAgentOutboundIdentity(cfg, agentId);
    const session = buildOutboundSessionContext({
        cfg,
        agentId,
        sessionKey: `cron:${jobId}:failure`,
    });
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
        abortController.abort();
    }, FAILURE_NOTIFICATION_TIMEOUT_MS);
    try {
        await deliverOutboundPayloads({
            cfg,
            channel: resolvedTarget.channel,
            to: resolvedTarget.to,
            accountId: resolvedTarget.accountId,
            threadId: resolvedTarget.threadId,
            payloads: [{ text: message }],
            session,
            identity,
            bestEffort: false,
            deps: createOutboundSendDeps(deps),
            abortSignal: abortController.signal,
        });
    }
    catch (err) {
        cronDeliveryLogger.warn({
            err: formatErrorMessage(err),
            channel: resolvedTarget.channel,
            to: resolvedTarget.to,
        }, "cron: failure destination announce failed");
    }
    finally {
        clearTimeout(timeout);
    }
}
