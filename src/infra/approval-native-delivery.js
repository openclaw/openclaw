import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
function dedupeTargets(targets) {
    const seen = new Set();
    const deduped = [];
    for (const target of targets) {
        const key = buildChannelApprovalNativeTargetKey(target.target);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(target);
    }
    return deduped;
}
export async function resolveChannelNativeApprovalDeliveryPlan(params) {
    const adapter = params.adapter;
    if (!adapter) {
        return {
            targets: [],
            originTarget: null,
            notifyOriginWhenDmOnly: false,
        };
    }
    const capabilities = adapter.describeDeliveryCapabilities({
        cfg: params.cfg,
        accountId: params.accountId,
        approvalKind: params.approvalKind,
        request: params.request,
    });
    if (!capabilities.enabled) {
        return {
            targets: [],
            originTarget: null,
            notifyOriginWhenDmOnly: false,
        };
    }
    const originTarget = capabilities.supportsOriginSurface && adapter.resolveOriginTarget
        ? ((await adapter.resolveOriginTarget({
            cfg: params.cfg,
            accountId: params.accountId,
            approvalKind: params.approvalKind,
            request: params.request,
        })) ?? null)
        : null;
    const approverDmTargets = capabilities.supportsApproverDmSurface && adapter.resolveApproverDmTargets
        ? await adapter.resolveApproverDmTargets({
            cfg: params.cfg,
            accountId: params.accountId,
            approvalKind: params.approvalKind,
            request: params.request,
        })
        : [];
    const plannedTargets = [];
    const preferOrigin = capabilities.preferredSurface === "origin" || capabilities.preferredSurface === "both";
    const preferApproverDm = capabilities.preferredSurface === "approver-dm" || capabilities.preferredSurface === "both";
    if (preferOrigin && originTarget) {
        plannedTargets.push({
            surface: "origin",
            target: originTarget,
            reason: "preferred",
        });
    }
    if (preferApproverDm) {
        for (const target of approverDmTargets) {
            plannedTargets.push({
                surface: "approver-dm",
                target,
                reason: "preferred",
            });
        }
    }
    else if (!originTarget) {
        for (const target of approverDmTargets) {
            plannedTargets.push({
                surface: "approver-dm",
                target,
                reason: "fallback",
            });
        }
    }
    return {
        targets: dedupeTargets(plannedTargets),
        originTarget,
        notifyOriginWhenDmOnly: capabilities.preferredSurface === "approver-dm" &&
            capabilities.notifyOriginWhenDmOnly === true &&
            originTarget !== null,
    };
}
