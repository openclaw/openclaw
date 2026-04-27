import { resolveChannelNativeApprovalDeliveryPlan, } from "./approval-native-delivery.js";
import { createApprovalNativeRouteReporter } from "./approval-native-route-coordinator.js";
import { createExecApprovalChannelRuntime, } from "./exec-approval-channel-runtime.js";
export async function deliverApprovalRequestViaChannelNativePlan(params) {
    const deliveryPlan = await resolveChannelNativeApprovalDeliveryPlan({
        cfg: params.cfg,
        accountId: params.accountId,
        approvalKind: params.approvalKind,
        request: params.request,
        adapter: params.adapter,
    });
    const deliveredKeys = new Set();
    const pendingEntries = [];
    const deliveredTargets = [];
    for (const plannedTarget of deliveryPlan.targets) {
        try {
            const preparedTarget = await params.prepareTarget({
                plannedTarget,
                request: params.request,
            });
            if (!preparedTarget) {
                continue;
            }
            if (deliveredKeys.has(preparedTarget.dedupeKey)) {
                params.onDuplicateSkipped?.({
                    plannedTarget,
                    preparedTarget,
                    request: params.request,
                });
                continue;
            }
            const entry = await params.deliverTarget({
                plannedTarget,
                preparedTarget: preparedTarget.target,
                request: params.request,
            });
            if (!entry) {
                continue;
            }
            deliveredKeys.add(preparedTarget.dedupeKey);
            pendingEntries.push(entry);
            deliveredTargets.push(plannedTarget);
            params.onDelivered?.({
                plannedTarget,
                preparedTarget,
                request: params.request,
                entry,
            });
        }
        catch (error) {
            params.onDeliveryError?.({
                error,
                plannedTarget,
                request: params.request,
            });
        }
    }
    return {
        entries: pendingEntries,
        deliveryPlan,
        deliveredTargets,
    };
}
function defaultResolveApprovalKind(request) {
    return request.id.startsWith("plugin:") ? "plugin" : "exec";
}
export function createChannelNativeApprovalRuntime(adapter) {
    const nowMs = adapter.nowMs ?? Date.now;
    const resolveApprovalKind = adapter.resolveApprovalKind ?? ((request) => defaultResolveApprovalKind(request));
    let runtimeRequest = null;
    const handledEventKinds = new Set(adapter.eventKinds ?? ["exec"]);
    const routeReporter = createApprovalNativeRouteReporter({
        handledKinds: handledEventKinds,
        channel: adapter.channel,
        channelLabel: adapter.channelLabel,
        accountId: adapter.accountId,
        requestGateway: async (method, params) => {
            if (!runtimeRequest) {
                throw new Error(`${adapter.label}: gateway client not connected`);
            }
            return (await runtimeRequest(method, params));
        },
    });
    const runtime = createExecApprovalChannelRuntime({
        label: adapter.label,
        clientDisplayName: adapter.clientDisplayName,
        cfg: adapter.cfg,
        gatewayUrl: adapter.gatewayUrl,
        eventKinds: adapter.eventKinds,
        isConfigured: adapter.isConfigured,
        shouldHandle: (request) => {
            const approvalKind = resolveApprovalKind(request);
            routeReporter.observeRequest({
                approvalKind,
                request,
            });
            let shouldHandle;
            try {
                shouldHandle = adapter.shouldHandle(request);
            }
            catch (error) {
                void routeReporter.reportSkipped({
                    approvalKind,
                    request,
                });
                throw error;
            }
            if (shouldHandle) {
                return shouldHandle;
            }
            void routeReporter.reportSkipped({
                approvalKind,
                request,
            });
            return false;
        },
        finalizeResolved: adapter.finalizeResolved,
        finalizeExpired: adapter.finalizeExpired,
        onStopped: adapter.onStopped,
        beforeGatewayClientStart: () => {
            routeReporter.start();
        },
        nowMs,
        deliverRequested: async (request) => {
            const approvalKind = resolveApprovalKind(request);
            let deliveryPlan = {
                targets: [],
                originTarget: null,
                notifyOriginWhenDmOnly: false,
            };
            let deliveredTargets = [];
            try {
                const pendingContent = await adapter.buildPendingContent({
                    request,
                    approvalKind,
                    nowMs: nowMs(),
                });
                const deliveryResult = await deliverApprovalRequestViaChannelNativePlan({
                    cfg: adapter.cfg,
                    accountId: adapter.accountId,
                    approvalKind,
                    request,
                    adapter: adapter.nativeAdapter,
                    prepareTarget: async ({ plannedTarget, request }) => await adapter.prepareTarget({
                        plannedTarget,
                        request,
                        approvalKind,
                        pendingContent,
                    }),
                    deliverTarget: async ({ plannedTarget, preparedTarget, request }) => await adapter.deliverTarget({
                        plannedTarget,
                        preparedTarget,
                        request,
                        approvalKind,
                        pendingContent,
                    }),
                    onDeliveryError: adapter.onDeliveryError
                        ? ({ error, plannedTarget, request }) => {
                            adapter.onDeliveryError?.({
                                error,
                                plannedTarget,
                                request,
                                approvalKind,
                                pendingContent,
                            });
                        }
                        : undefined,
                    onDuplicateSkipped: adapter.onDuplicateSkipped
                        ? ({ plannedTarget, preparedTarget, request }) => {
                            adapter.onDuplicateSkipped?.({
                                plannedTarget,
                                preparedTarget,
                                request,
                                approvalKind,
                                pendingContent,
                            });
                        }
                        : undefined,
                    onDelivered: adapter.onDelivered
                        ? ({ plannedTarget, preparedTarget, request, entry }) => {
                            adapter.onDelivered?.({
                                plannedTarget,
                                preparedTarget,
                                request,
                                approvalKind,
                                pendingContent,
                                entry,
                            });
                        }
                        : undefined,
                });
                deliveryPlan = deliveryResult.deliveryPlan;
                deliveredTargets = deliveryResult.deliveredTargets;
                return deliveryResult.entries;
            }
            finally {
                await routeReporter.reportDelivery({
                    approvalKind,
                    request,
                    deliveryPlan,
                    deliveredTargets,
                });
            }
        },
    });
    runtimeRequest = (method, params) => runtime.request(method, params);
    return {
        ...runtime,
        async start() {
            try {
                await runtime.start();
            }
            catch (error) {
                await routeReporter.stop();
                throw error;
            }
        },
        async stop() {
            await routeReporter.stop();
            await runtime.stop();
        },
    };
}
