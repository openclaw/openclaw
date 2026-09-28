// Coordinates native approval delivery routing and notices.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ChannelApprovalNativeDeliveryPlan,
  ChannelApprovalNativePlannedTarget,
} from "./approval-native-delivery.js";
import {
  normalizeApprovalRouteChannel,
  resolveApprovalRouteNotice,
  type ApprovalRouteSkipReason,
} from "./approval-native-route-notice.js";
import {
  PLUGIN_TERMINAL_ROUTE_GRACE_MS,
  capturePluginOrigin,
  clearPluginOrigin,
  clearPluginTerminalNotice,
  finishPluginOriginRouting,
  getPluginTerminalNotice,
  isPluginOriginCurrent,
  markPluginOriginDelivered,
  maybeSendPluginTerminalNotice,
  publishPluginTerminalForState,
} from "./approval-native-route-plugin-notices.js";
import type {
  ApprovalNativeRouteCoordinatorState,
  ApprovalRouteRuntimeRecord,
  ApprovalRouteSelection,
  ApprovalRouteSelectionVerdict,
  PendingApprovalRouteNotice,
  PluginTerminalStatus,
} from "./approval-native-route-types.js";
import { projectApprovalRouteRequest } from "./approval-request-projection.js";
import type {
  ApprovalRequestChannelRouteClass,
  ApprovalRequestInput as ApprovalRequest,
  ChannelApprovalKind,
} from "./approval-types.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";
export type {
  ApprovalNativeRouteCoordinatorState,
  ApprovalRouteRuntimeRecord,
} from "./approval-native-route-types.js";

function createApprovalNativeRouteCoordinatorState(): ApprovalNativeRouteCoordinatorState {
  return {
    activeRuntimes: new Map(),
    pendingNotices: new Map(),
    pluginTerminalNotices: new Map(),
    selections: new Map(),
    pluginOrigins: new Map(),
    runtimeSeq: 0,
    closed: false,
  };
}

function clearApprovalRouteSelection(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const selection = state.selections.get(approvalId);
  if (!selection) {
    return;
  }
  state.selections.delete(approvalId);
  clearTimeout(selection.cleanupTimeout);
}

function routeGroupKey(runtime: ApprovalRouteRuntimeRecord): string {
  return normalizeApprovalRouteChannel(runtime.channel) || runtime.runtimeId;
}

function createApprovalRouteSelection(
  state: ApprovalNativeRouteCoordinatorState,
  params: { request: ApprovalRequest; approvalKind: ChannelApprovalKind },
): ApprovalRouteSelection {
  const publicRequest = projectApprovalRouteRequest(params.request);
  const runtimes = Array.from(state.activeRuntimes.values()).filter((runtime) =>
    runtime.handledKinds.has(params.approvalKind),
  );
  const verdicts = new Map<string, ApprovalRouteSelectionVerdict>();
  const groups = new Map<string, ApprovalRouteRuntimeRecord[]>();
  for (const runtime of runtimes) {
    const key = routeGroupKey(runtime);
    groups.set(key, [...(groups.get(key) ?? []), runtime]);
  }

  const selectedRuntimeIds = new Set<string>();
  for (const group of groups.values()) {
    const candidates: ApprovalRouteRuntimeRecord[] = [];
    for (const runtime of group) {
      try {
        if (runtime.shouldHandle(publicRequest)) {
          candidates.push(runtime);
        }
      } catch (error) {
        verdicts.set(runtime.runtimeId, { kind: "selector-error", error });
      }
    }
    let routeClass: ApprovalRequestChannelRouteClass;
    try {
      routeClass = group[0]?.classifyRoute(publicRequest) ?? "unbound";
    } catch (error) {
      for (const runtime of group) {
        verdicts.set(runtime.runtimeId, { kind: "selector-error", error });
      }
      continue;
    }
    if (routeClass === "bound-or-explicit") {
      if (candidates.length === 0) {
        for (const runtime of group) {
          if (!verdicts.has(runtime.runtimeId)) {
            verdicts.set(runtime.runtimeId, { kind: "owner-unavailable" });
          }
        }
        continue;
      }
      for (const runtime of candidates) {
        selectedRuntimeIds.add(runtime.runtimeId);
      }
    } else if (routeClass === "unbound" && candidates.length === 1) {
      const [candidate] = candidates;
      if (candidate) {
        selectedRuntimeIds.add(candidate.runtimeId);
      }
    } else if (routeClass === "unbound" && candidates.length > 1) {
      for (const runtime of candidates) {
        verdicts.set(runtime.runtimeId, { kind: "ambiguous-owner" });
      }
    }
  }

  for (const runtime of runtimes) {
    if (selectedRuntimeIds.has(runtime.runtimeId)) {
      verdicts.set(runtime.runtimeId, { kind: "selected" });
    } else if (!verdicts.has(runtime.runtimeId)) {
      verdicts.set(runtime.runtimeId, { kind: "ineligible" });
    }
  }

  const timeoutMs = Math.min(
    Math.max(
      0,
      params.request.expiresAtMs -
        Date.now() +
        (params.approvalKind === "plugin" ? PLUGIN_TERMINAL_ROUTE_GRACE_MS : 0),
    ),
    0x7fffffff,
  );
  const cleanupTimeout = setTimeout(() => {
    clearApprovalRouteSelection(state, params.request.id);
  }, timeoutMs);
  cleanupTimeout.unref?.();
  const selection: ApprovalRouteSelection = {
    verdicts,
    cleanupTimeout,
  };
  state.selections.set(params.request.id, selection);
  return selection;
}

function resolveApprovalRouteSelection(
  state: ApprovalNativeRouteCoordinatorState,
  params: { request: ApprovalRequest; approvalKind: ChannelApprovalKind },
): ApprovalRouteSelection {
  return state.selections.get(params.request.id) ?? createApprovalRouteSelection(state, params);
}

const defaultCoordinatorState = createApprovalNativeRouteCoordinatorState();
const MAX_APPROVAL_ROUTE_NOTICE_TTL_MS = 5 * 60_000;

function clearPendingApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const entry = state.pendingNotices.get(approvalId);
  if (!entry) {
    return;
  }
  state.pendingNotices.delete(approvalId);
  clearTimeout(entry.cleanupTimeout);
}

function createPendingApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  params: {
    request: ApprovalRequest;
    approvalKind: ChannelApprovalKind;
  },
): PendingApprovalRouteNotice {
  const timeoutMs = Math.min(
    Math.max(
      0,
      params.request.expiresAtMs -
        Date.now() +
        (params.approvalKind === "plugin" ? PLUGIN_TERMINAL_ROUTE_GRACE_MS : 0),
    ),
    MAX_APPROVAL_ROUTE_NOTICE_TTL_MS,
  );
  const cleanupTimeout = setTimeout(() => {
    void maybeFinalizeApprovalRouteNotice(state, params.request.id, { force: true });
  }, timeoutMs);
  cleanupTimeout.unref?.();
  return {
    request: params.request,
    approvalKind: params.approvalKind,
    reports: new Map(),
    cleanupTimeout,
  };
}

/** Returns whether a native approval runtime is active for the requested channel/account scope. */
export function hasActiveApprovalNativeRouteRuntime(params: {
  approvalKind: ChannelApprovalKind;
  channel?: string | null;
  accountId?: string | null;
}): boolean {
  return hasActiveApprovalNativeRouteRuntimeForState(defaultCoordinatorState, params);
}

function hasActiveApprovalNativeRouteRuntimeForState(
  state: ApprovalNativeRouteCoordinatorState,
  params: {
    approvalKind: ChannelApprovalKind;
    channel?: string | null;
    accountId?: string | null;
  },
): boolean {
  const channel = normalizeApprovalRouteChannel(params.channel);
  const accountId = normalizeOptionalString(params.accountId);
  const matchingRuntimes = Array.from(state.activeRuntimes.values()).filter((runtime) => {
    if (!runtime.handledKinds.has(params.approvalKind)) {
      return false;
    }
    if (channel && normalizeApprovalRouteChannel(runtime.channel) !== channel) {
      return false;
    }
    const runtimeAccountId = normalizeOptionalString(runtime.accountId);
    return (
      accountId === undefined || runtimeAccountId === undefined || runtimeAccountId === accountId
    );
  });
  return accountId === undefined ? matchingRuntimes.length === 1 : matchingRuntimes.length > 0;
}

async function maybeFinalizeApprovalRouteNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
  options?: { force?: boolean },
): Promise<void> {
  const entry = state.pendingNotices.get(approvalId);
  if (!entry) {
    return;
  }
  const selection = state.selections.get(approvalId);
  if (!selection) {
    if (options?.force) {
      clearPendingApprovalRouteNotice(state, approvalId);
    }
    return;
  }
  const originRoute = state.pluginOrigins.get(approvalId)?.localRoute;
  // Local report callbacks can run during publication, before the Gateway
  // knows whether a local reviewer accepted the request.
  if (originRoute === "pending") {
    return;
  }
  if (originRoute === "none") {
    clearPendingApprovalRouteNotice(state, approvalId);
    return;
  }
  if (entry.approvalKind === "plugin" && !state.pluginOrigins.has(approvalId)) {
    // Request turn-source fields are public RPC metadata, not bot-send authority.
    clearPendingApprovalRouteNotice(state, approvalId);
    return;
  }
  if (!options?.force) {
    for (const runtimeId of selection.verdicts.keys()) {
      if (!entry.reports.has(runtimeId)) {
        return;
      }
    }
  }
  const missingSelectedRuntime = Array.from(selection.verdicts).some(
    ([runtimeId, verdict]) => verdict.kind === "selected" && !entry.reports.has(runtimeId),
  );
  if (!options?.force && missingSelectedRuntime) {
    return;
  }
  if (
    selection.pluginTerminalStatus === "allowed" ||
    selection.pluginTerminalStatus === "cancelled"
  ) {
    clearPendingApprovalRouteNotice(state, approvalId);
    return;
  }

  const reports = Array.from(entry.reports.values());
  const pluginOrigin =
    entry.approvalKind === "plugin" ? state.pluginOrigins.get(approvalId) : undefined;
  const notice = resolveApprovalRouteNotice({
    activeRuntimes: state.activeRuntimes,
    approvalKind: entry.approvalKind,
    request: entry.request,
    reports,
    missingSelectedRuntime,
  });
  const terminalNotice = pluginOrigin ? getPluginTerminalNotice(state, entry.request) : undefined;
  if (pluginOrigin && terminalNotice && notice) {
    terminalNotice.requestGateway = pluginOrigin.requestGateway;
    terminalNotice.target = pluginOrigin.target;
    terminalNotice.isOriginCurrent = (cfg) => isPluginOriginCurrent(state, pluginOrigin, cfg);
  }
  clearPendingApprovalRouteNotice(state, approvalId);
  if (!notice) {
    return;
  }
  const initialNotice = Promise.resolve().then(async () => {
    try {
      // The same owner check runs again at platform handoff; pending work never
      // enters the durable queue where it could outlive this approval.
      const isCurrent = (cfg?: OpenClawConfig) =>
        !(
          state.closed ||
          state.selections.get(approvalId) !== selection ||
          selection.pluginTerminalStatus ||
          terminalNotice?.status ||
          entry.request.expiresAtMs <= Date.now()
        ) &&
        (entry.approvalKind !== "plugin" ||
          (pluginOrigin !== undefined && isPluginOriginCurrent(state, pluginOrigin, cfg)));
      if (!isCurrent()) {
        return;
      }
      const payload = {
        channel: pluginOrigin?.target.channel ?? notice.target.channel,
        to: pluginOrigin?.target.to ?? notice.target.to,
        accountId: pluginOrigin?.target.accountId ?? notice.target.accountId ?? undefined,
        threadId: pluginOrigin?.target.threadId ?? notice.target.threadId ?? undefined,
        message: notice.text,
        idempotencyKey: `approval-route-notice:${approvalId}`,
      };
      if (entry.approvalKind === "plugin") {
        await (pluginOrigin?.requestGateway ?? notice.requestGateway)("send", payload, {
          liveOnlyWhenCurrent: isCurrent,
          approvalRequest: entry.request,
        });
      } else {
        await notice.requestGateway("send", payload);
      }
    } catch {
      // The approval delivery already succeeded; the follow-up notice is best-effort.
    }
  });
  if (terminalNotice) {
    terminalNotice.initialNotice = initialNotice;
  }
  await initialNotice;
  if (terminalNotice) {
    try {
      await maybeSendPluginTerminalNotice(state, approvalId);
    } catch {
      // The card was delivered; a failed origin follow-up cannot undo it.
    }
  }
}

/** Tracks native approval deliveries and sends origin-chat notices after all observed runtimes report. */
export function createApprovalNativeRouteReporter(
  params: Omit<ApprovalRouteRuntimeRecord, "runtimeId">,
) {
  return createApprovalNativeRouteReporterForState(defaultCoordinatorState, params);
}

function createApprovalNativeRouteReporterForState(
  state: ApprovalNativeRouteCoordinatorState,
  params: Omit<ApprovalRouteRuntimeRecord, "runtimeId">,
) {
  const runtimeId = `native-approval-route:${++state.runtimeSeq}`;
  let registered = false;

  const report = async (payload: {
    approvalKind: ChannelApprovalKind;
    request: ApprovalRequest;
    deliveryPlan: ChannelApprovalNativeDeliveryPlan;
    deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
    skipReason?: ApprovalRouteSkipReason;
  }): Promise<void> => {
    if (state.closed || !registered || !params.handledKinds.has(payload.approvalKind)) {
      return;
    }
    const publicRequest = projectApprovalRouteRequest(payload.request);
    // After expiry, only a denied/expired terminal can still await delivery;
    // a late report must not resurrect a resolved request's pending notice.
    if (
      payload.approvalKind === "plugin" &&
      payload.request.expiresAtMs <= Date.now() &&
      !state.pluginTerminalNotices.get(payload.request.id)?.status &&
      !state.selections.has(payload.request.id)
    ) {
      return;
    }
    const selection = resolveApprovalRouteSelection(state, {
      approvalKind: payload.approvalKind,
      request: publicRequest,
    });
    if (!selection.verdicts.has(runtimeId)) {
      return;
    }
    const entry =
      state.pendingNotices.get(payload.request.id) ??
      createPendingApprovalRouteNotice(state, {
        request: publicRequest,
        approvalKind: payload.approvalKind,
      });
    const runtimeRecord = state.activeRuntimes.get(runtimeId);
    markPluginOriginDelivered(state, payload.request.id, runtimeRecord, payload.deliveredTargets);
    entry.reports.set(runtimeId, {
      runtimeId,
      request: publicRequest,
      channel: params.channel,
      channelLabel: params.channelLabel,
      accountId: params.accountId,
      deliveryPlan: payload.deliveryPlan,
      deliveredTargets: payload.deliveredTargets,
      requestGateway: params.requestGateway,
      skipReason: payload.skipReason,
    });
    state.pendingNotices.set(payload.request.id, entry);
    await maybeFinalizeApprovalRouteNotice(state, payload.request.id);
  };

  return {
    selectRequest(payload: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
    }): ApprovalRouteSelectionVerdict {
      if (state.closed || !params.handledKinds.has(payload.approvalKind)) {
        return { kind: "ineligible" };
      }
      const publicRequest = projectApprovalRouteRequest(payload.request);
      if (!registered) {
        try {
          return params.shouldHandle(publicRequest) ? { kind: "selected" } : { kind: "ineligible" };
        } catch (error) {
          return { kind: "selector-error", error };
        }
      }
      const selection = resolveApprovalRouteSelection(state, {
        approvalKind: payload.approvalKind,
        request: publicRequest,
      });
      const entry =
        state.pendingNotices.get(payload.request.id) ??
        createPendingApprovalRouteNotice(state, {
          request: publicRequest,
          approvalKind: payload.approvalKind,
        });
      state.pendingNotices.set(payload.request.id, entry);
      return selection.verdicts.get(runtimeId) ?? { kind: "ineligible" };
    },
    start(): void {
      if (state.closed || registered) {
        return;
      }
      state.activeRuntimes.set(runtimeId, {
        runtimeId,
        handledKinds: params.handledKinds,
        channel: params.channel,
        channelLabel: params.channelLabel,
        accountId: params.accountId,
        sourceConfig: params.sourceConfig,
        isOriginCurrent: params.isOriginCurrent,
        requestGateway: params.requestGateway,
        shouldHandle: params.shouldHandle,
        classifyRoute: params.classifyRoute,
      });
      registered = true;
    },
    async reportSkipped(paramsValue: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
      reason: ApprovalRouteSkipReason;
    }): Promise<void> {
      await report({
        approvalKind: paramsValue.approvalKind,
        request: paramsValue.request,
        deliveryPlan: {
          targets: [],
          originTarget: null,
          notifyOriginWhenDmOnly: false,
        },
        deliveredTargets: [],
        skipReason: paramsValue.reason,
      });
    },
    async reportDelivery(paramsLocal: {
      approvalKind: ChannelApprovalKind;
      request: ApprovalRequest;
      deliveryPlan: ChannelApprovalNativeDeliveryPlan;
      deliveredTargets: readonly ChannelApprovalNativePlannedTarget[];
    }): Promise<void> {
      await report(paramsLocal);
    },
    completeRequest(approvalId: string): void {
      // A Gateway terminal can overtake delivery reporting. Keep the selection
      // until its route is known so the durable outcome reaches the origin.
      const terminalNotice = state.pluginTerminalNotices.get(approvalId);
      if (terminalNotice?.status && !terminalNotice.target) {
        return;
      }
      const terminalStatus = state.selections.get(approvalId)?.pluginTerminalStatus;
      if (terminalStatus === "allowed" || terminalStatus === "cancelled") {
        // Another selected runtime may still report; retain the bounded
        // terminal marker so it cannot announce an already resolved request.
        clearPendingApprovalRouteNotice(state, approvalId);
        return;
      }
      clearApprovalRouteSelection(state, approvalId);
      clearPendingApprovalRouteNotice(state, approvalId);
    },
    async stop(): Promise<void> {
      if (!registered) {
        return;
      }
      for (const entry of Array.from(state.pendingNotices.values())) {
        const selection = state.selections.get(entry.request.id);
        if (selection?.verdicts.has(runtimeId) && !entry.reports.has(runtimeId)) {
          await report({
            request: entry.request,
            approvalKind: entry.approvalKind,
            deliveryPlan: { targets: [], originTarget: null, notifyOriginWhenDmOnly: false },
            deliveredTargets: [],
            skipReason:
              selection.verdicts.get(runtimeId)?.kind === "selected"
                ? "owner-unavailable"
                : "ineligible",
          });
        }
      }
      registered = false;
      state.activeRuntimes.delete(runtimeId);
    },
  };
}

export type ApprovalNativeRouteCoordinator = {
  createReporter: typeof createApprovalNativeRouteReporter;
  hasActiveRuntime: typeof hasActiveApprovalNativeRouteRuntime;
  capturePluginOrigin: (
    request: PluginApprovalRequest,
    retainApprovalBinding?: () => (() => void) | null,
    sourceGateway?: {
      requestGateway: ApprovalRouteRuntimeRecord["requestGateway"];
      isOriginCurrent: (request: PluginApprovalRequest, cfg?: OpenClawConfig) => boolean;
    },
  ) => void;
  finishPluginOriginRouting: (approvalId: string, localRouteSelected: boolean) => Promise<void>;
  publishPluginTerminal: (params: {
    approvalId: string;
    status: PluginTerminalStatus;
  }) => Promise<void>;
  close: () => void;
};

/** Receives canonical terminal events for remote native runtimes using the process coordinator. */
export async function publishDefaultPluginTerminal(params: {
  approvalId: string;
  status: PluginTerminalStatus;
}): Promise<void> {
  await publishPluginTerminalForState(defaultCoordinatorState, params);
}

/** Reads native route activity from the owning Gateway coordinator, else the process default. */
export function hasActiveNativeApprovalRoute(
  coordinator: ApprovalNativeRouteCoordinator | undefined,
  params: Parameters<typeof hasActiveApprovalNativeRouteRuntime>[0],
): boolean {
  return coordinator?.hasActiveRuntime(params) ?? hasActiveApprovalNativeRouteRuntime(params);
}

/** Creates an instance-local route coordinator so Gateway runtimes cannot share account state. */
export function createApprovalNativeRouteCoordinator(): ApprovalNativeRouteCoordinator {
  const state = createApprovalNativeRouteCoordinatorState();
  return {
    createReporter: (params) => createApprovalNativeRouteReporterForState(state, params),
    hasActiveRuntime: (params) => hasActiveApprovalNativeRouteRuntimeForState(state, params),
    capturePluginOrigin: (request, retainApprovalBinding, sourceGateway) =>
      capturePluginOrigin(state, request, retainApprovalBinding, sourceGateway),
    finishPluginOriginRouting: async (approvalId, localRouteSelected) => {
      const pending = finishPluginOriginRouting(state, approvalId, localRouteSelected);
      if (state.pluginOrigins.get(approvalId)?.localRoute === "none") {
        clearPendingApprovalRouteNotice(state, approvalId);
      } else {
        await maybeFinalizeApprovalRouteNotice(state, approvalId);
      }
      await pending;
    },
    publishPluginTerminal: async (params) => await publishPluginTerminalForState(state, params),
    close: () => {
      // Closing retires this Gateway-owned coordinator permanently. Delayed channel
      // startup must not repopulate routes belonging to the retired instance.
      state.closed = true;
      for (const approvalId of Array.from(state.pendingNotices.keys())) {
        clearPendingApprovalRouteNotice(state, approvalId);
      }
      for (const approvalId of Array.from(state.selections.keys())) {
        clearApprovalRouteSelection(state, approvalId);
      }
      for (const approvalId of Array.from(state.pluginTerminalNotices.keys())) {
        clearPluginTerminalNotice(state, approvalId);
      }
      for (const approvalId of Array.from(state.pluginOrigins.keys())) {
        clearPluginOrigin(state, approvalId);
      }
      state.activeRuntimes.clear();
    },
  };
}
