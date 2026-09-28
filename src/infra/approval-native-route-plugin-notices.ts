// Owns plugin approval origin bindings and requester notices across native runtimes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ChannelApprovalNativePlannedTarget } from "./approval-native-delivery.js";
import {
  normalizeApprovalRouteChannel,
  type GatewayRequestFn,
} from "./approval-native-route-notice.js";
import type {
  ApprovalNativeRouteCoordinatorState,
  ApprovalRouteRuntimeRecord,
  PluginOriginBinding,
  PluginTerminalNotice,
  PluginTerminalStatus,
} from "./approval-native-route-types.js";
import { buildChannelApprovalNativeTargetKey } from "./approval-native-target-key.js";
import { projectApprovalRouteRequest } from "./approval-request-projection.js";
import type { ApprovalRequestInput as ApprovalRequest } from "./approval-types.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

export const PLUGIN_TERMINAL_ROUTE_GRACE_MS = 60_000;

export function clearPluginOrigin(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const binding = state.pluginOrigins.get(approvalId);
  if (!binding) {
    return;
  }
  state.pluginOrigins.delete(approvalId);
  clearTimeout(binding.cleanupTimeout);
  binding.releaseApprovalBinding?.();
}

export function capturePluginOrigin(
  state: ApprovalNativeRouteCoordinatorState,
  request: PluginApprovalRequest,
  retainApprovalBinding?: () => (() => void) | null,
  sourceGateway?: {
    requestGateway: GatewayRequestFn;
    isOriginCurrent: (request: PluginApprovalRequest, cfg?: OpenClawConfig) => boolean;
  },
): void {
  const publicRequest = projectApprovalRouteRequest(request);
  const source = publicRequest.request;
  const channel = normalizeApprovalRouteChannel(source.turnSourceChannel);
  const accountId = normalizeOptionalString(source.turnSourceAccountId);
  const to = normalizeOptionalString(source.turnSourceTo);
  if (
    state.closed ||
    state.pluginOrigins.has(publicRequest.id) ||
    publicRequest.expiresAtMs <= Date.now() ||
    !source.approvalSource ||
    normalizeApprovalRouteChannel(source.approvalSource.channel) !== channel ||
    !channel ||
    !accountId ||
    !to
  ) {
    return;
  }
  const matches = Array.from(state.activeRuntimes.values()).filter(
    (runtime) =>
      runtime.handledKinds.has("plugin") &&
      normalizeApprovalRouteChannel(runtime.channel) === channel &&
      normalizeOptionalString(runtime.accountId) === accountId,
  );
  if (matches.length > 1) {
    return;
  }
  const runtime = matches[0];
  // A channel runtime without a source hook uses the Gateway's exact live source task.
  // A rejecting runtime hook remains authoritative and cannot fall back.
  const isOriginCurrent = runtime?.isOriginCurrent ?? sourceGateway?.isOriginCurrent;
  const requestGateway = runtime?.isOriginCurrent
    ? runtime.requestGateway
    : sourceGateway?.requestGateway;
  if (!isOriginCurrent || !requestGateway) {
    return;
  }
  try {
    if (!isOriginCurrent(publicRequest)) {
      return;
    }
  } catch {
    return;
  }
  // The manager's resolved grace is shorter than a remote card handoff. Keep
  // the exact approval binding until this origin route is retired.
  const releaseApprovalBinding = retainApprovalBinding?.();
  if (retainApprovalBinding && !releaseApprovalBinding) {
    return;
  }
  let cleanupTimeout: NodeJS.Timeout | undefined;
  try {
    cleanupTimeout = setTimeout(
      () => clearPluginOrigin(state, publicRequest.id),
      Math.min(
        Math.max(0, publicRequest.expiresAtMs - Date.now() + PLUGIN_TERMINAL_ROUTE_GRACE_MS),
        0x7fffffff,
      ),
    );
    cleanupTimeout.unref?.();
    state.pluginOrigins.set(publicRequest.id, {
      request: publicRequest,
      runtime,
      requestGateway,
      isOriginCurrent: (cfg) => isOriginCurrent(publicRequest, cfg) === true,
      target: {
        channel,
        to,
        accountId,
        threadId: source.turnSourceThreadId,
      },
      releaseApprovalBinding: releaseApprovalBinding ?? undefined,
      localRoute: "pending",
      cleanupTimeout,
    });
  } catch (error) {
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
    }
    releaseApprovalBinding?.();
    throw error;
  }
}

export function isPluginOriginCurrent(
  state: ApprovalNativeRouteCoordinatorState,
  binding: PluginOriginBinding,
  cfg?: OpenClawConfig,
): boolean {
  const runtime = binding.runtime;
  if (
    state.closed ||
    state.pluginOrigins.get(binding.request.id) !== binding ||
    (runtime && state.activeRuntimes.get(runtime.runtimeId) !== runtime)
  ) {
    return false;
  }
  try {
    return binding.isOriginCurrent(cfg);
  } catch {
    return false;
  }
}

export function clearPluginTerminalNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): void {
  const entry = state.pluginTerminalNotices.get(approvalId);
  if (!entry) {
    return;
  }
  state.pluginTerminalNotices.delete(approvalId);
  clearTimeout(entry.cleanupTimeout);
}

export function getPluginTerminalNotice(
  state: ApprovalNativeRouteCoordinatorState,
  request: ApprovalRequest,
): PluginTerminalNotice {
  const existing = state.pluginTerminalNotices.get(request.id);
  if (existing) {
    return existing;
  }
  // Retain the actual native route until the Gateway's expiry can publish its
  // terminal outcome, even if the channel's local card timer fires first.
  const timeoutMs = Math.min(
    Math.max(0, request.expiresAtMs - Date.now()) + PLUGIN_TERMINAL_ROUTE_GRACE_MS,
    0x7fffffff,
  );
  const cleanupTimeout = setTimeout(() => clearPluginTerminalNotice(state, request.id), timeoutMs);
  cleanupTimeout.unref?.();
  const entry: PluginTerminalNotice = { request, sent: false, cleanupTimeout };
  state.pluginTerminalNotices.set(request.id, entry);
  return entry;
}

export async function maybeSendPluginTerminalNotice(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
): Promise<void> {
  const notice = state.pluginTerminalNotices.get(approvalId);
  if (state.pluginOrigins.get(approvalId)?.originDelivered) {
    clearPluginTerminalNotice(state, approvalId);
    return;
  }
  if (state.closed || !notice?.status || !notice.requestGateway || !notice.target || notice.sent) {
    return;
  }
  if (notice.sending) {
    await notice.sending;
    return;
  }
  const { target } = notice;
  const requestGateway = notice.requestGateway;
  const sending = (async () => {
    await notice.initialNotice?.catch(() => {});
    if (state.closed || state.pluginTerminalNotices.get(approvalId) !== notice) {
      return;
    }
    await requestGateway(
      "send",
      {
        channel: target.channel,
        to: target.to,
        accountId: target.accountId ?? undefined,
        threadId: target.threadId ?? undefined,
        message:
          notice.status === "expired"
            ? `Approval ${approvalId} timed out. The requested action did not run.`
            : `Approval ${approvalId} was denied. The requested action did not run.`,
        idempotencyKey: `approval-terminal-notice:${approvalId}`,
      },
      {
        // Origin status must not survive its reporter or account. A durable
        // queue replay cannot recover the original account's send authority.
        approvalRequest: notice.request,
        liveOnlyWhenCurrent: (cfg) =>
          !state.closed &&
          state.pluginTerminalNotices.get(approvalId) === notice &&
          !state.pluginOrigins.get(approvalId)?.originDelivered &&
          notice.isOriginCurrent?.(cfg) === true,
      },
    );
    notice.sent = true;
  })();
  notice.sending = sending;
  try {
    await sending;
  } finally {
    if (notice.sending === sending) {
      notice.sending = undefined;
    }
  }
}

export async function finishPluginOriginRouting(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
  localRouteSelected: boolean,
): Promise<void> {
  const binding = state.pluginOrigins.get(approvalId);
  if (!binding || binding.localRoute !== "pending") {
    return;
  }
  binding.localRoute = localRouteSelected ? "selected" : "none";
  if (localRouteSelected || binding.originDelivered) {
    return;
  }
  const current = (cfg?: OpenClawConfig) => isPluginOriginCurrent(state, binding, cfg);
  if (binding.terminalStatus === "allowed" || binding.terminalStatus === "cancelled") {
    return;
  }
  const terminalNotice = getPluginTerminalNotice(state, binding.request);
  terminalNotice.requestGateway = binding.requestGateway;
  terminalNotice.target = binding.target;
  terminalNotice.isOriginCurrent = current;
  if (binding.terminalStatus === "denied" || binding.terminalStatus === "expired") {
    terminalNotice.status = binding.terminalStatus;
  }
  if (!binding.terminalStatus && binding.request.expiresAtMs > Date.now()) {
    terminalNotice.initialNotice = binding.requestGateway(
      "send",
      {
        channel: binding.target.channel,
        to: binding.target.to,
        accountId: binding.target.accountId ?? undefined,
        threadId: binding.target.threadId ?? undefined,
        message: `Approval ${approvalId} required. An approver can review it in the Control UI or terminal UI.`,
        idempotencyKey: `approval-route-notice:${approvalId}`,
      },
      {
        approvalRequest: binding.request,
        liveOnlyWhenCurrent: (cfg) =>
          current(cfg) && !binding.terminalStatus && binding.request.expiresAtMs > Date.now(),
      },
    );
    try {
      await terminalNotice.initialNotice;
    } catch (error) {
      // A refused or uncertain pending send must not block a later denial notice.
      terminalNotice.initialNotice = undefined;
      await maybeSendPluginTerminalNotice(state, approvalId);
      throw error;
    }
  }
  await maybeSendPluginTerminalNotice(state, approvalId);
}

export function markPluginOriginDelivered(
  state: ApprovalNativeRouteCoordinatorState,
  approvalId: string,
  runtime: ApprovalRouteRuntimeRecord | undefined,
  deliveredTargets: readonly ChannelApprovalNativePlannedTarget[],
): void {
  const origin = state.pluginOrigins.get(approvalId);
  if (
    !origin ||
    !runtime ||
    !deliveredTargets.some(
      (target) =>
        target.surface === "origin" &&
        buildChannelApprovalNativeTargetKey(target.target) ===
          buildChannelApprovalNativeTargetKey(origin.target),
    )
  ) {
    return;
  }
  if (origin.runtime && origin.runtime !== runtime) {
    return;
  }
  if (!origin.runtime) {
    // A channel reporter can start after the Gateway captured a remote-only
    // route. Its actual origin card supersedes the Gateway's fallback notice.
    if (
      normalizeApprovalRouteChannel(runtime.channel) !== origin.target.channel ||
      normalizeOptionalString(runtime.accountId) !== origin.target.accountId
    ) {
      return;
    }
    try {
      if (runtime.isOriginCurrent?.(origin.request) !== true) {
        return;
      }
    } catch {
      return;
    }
  }
  origin.originDelivered = true;
  clearPluginTerminalNotice(state, approvalId);
}

export async function publishPluginTerminalForState(
  state: ApprovalNativeRouteCoordinatorState,
  { approvalId, status }: { approvalId: string; status: PluginTerminalStatus },
): Promise<void> {
  if (state.closed) {
    return;
  }
  const selection = state.selections.get(approvalId);
  if (selection) {
    selection.pluginTerminalStatus = status;
  }
  const origin = state.pluginOrigins.get(approvalId);
  if (origin) {
    origin.terminalStatus = status;
  }
  if (status === "allowed" || status === "cancelled") {
    clearPluginTerminalNotice(state, approvalId);
    return;
  }
  const pending = state.pendingNotices.get(approvalId);
  const notice =
    state.pluginTerminalNotices.get(approvalId) ??
    (pending?.approvalKind === "plugin"
      ? getPluginTerminalNotice(state, pending.request)
      : undefined);
  if (!notice || notice.sent) {
    return;
  }
  notice.status = status;
  await maybeSendPluginTerminalNotice(state, approvalId);
}
