import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { hasEffectivePairedDeviceRole, listDevicePairing } from "../infra/device-pairing.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { ExecApprovalRequest } from "../infra/exec-approvals.js";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistrations,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsExecApprovalAlert,
  sendApnsExecApprovalResolvedWake,
  sendApnsPluginApprovalAlert,
  sendApnsPluginApprovalResolvedWake,
  shouldClearStoredApnsRegistration,
  type ApnsAuthConfig,
  type ApnsRegistration,
  type ApnsRelayConfig,
} from "../infra/push-apns.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { APPROVALS_SCOPE, READ_SCOPE } from "./operator-scopes.js";

// iOS approval push delivery targets paired operator devices with APNs
// registrations. Request pushes require approval scope plus identity-read access
// so the client can validate gateway ownership before presenting or resolving.
// Cleanup pushes reuse original targets so badges can clear after scope changes.
const OPERATOR_ROLE = "operator";

type GatewayLikeLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

type ApprovalPushTarget = {
  deviceId: string;
  scopes: readonly string[];
};

type DeliveryTarget = {
  nodeId: string;
  registration: ApnsRegistration;
};

type DeliveryPlan = {
  targets: DeliveryTarget[];
  directAuth?: ApnsAuthConfig;
  relayConfig?: ApnsRelayConfig;
};

type ApprovalDeliveryState = {
  nodeIds: string[];
  requestPushPromise: Promise<{ attempted: number; delivered: number }>;
};

type ApprovalPushSendResult = {
  ok: boolean;
  status: number;
  reason?: string;
};

type ApprovalRequestLike = { id: string };
type ApprovalPushParams = ReturnType<typeof approvalPushTransport> & {
  approvalId: string;
  gatewayDeviceId: string;
};

type ApprovalPushDriver<TRequest extends ApprovalRequestLike> = {
  approvalKind: ChannelApprovalKind;
  sendRequested: (request: TRequest, params: ApprovalPushParams) => Promise<ApprovalPushSendResult>;
  sendResolved: (params: ApprovalPushParams) => Promise<ApprovalPushSendResult>;
};

function isIosPlatform(platform: string | undefined): boolean {
  const normalized = normalizeOptionalLowercaseString(platform) ?? "";
  return normalized.startsWith("ios") || normalized.startsWith("ipados");
}

function approvalPushTransport(target: DeliveryTarget, plan: DeliveryPlan) {
  return target.registration.transport === "direct"
    ? { nodeId: target.nodeId, registration: target.registration, auth: plan.directAuth! }
    : { nodeId: target.nodeId, registration: target.registration, relayConfig: plan.relayConfig! };
}

async function resolvePairedTargets(
  isTargetVisible?: (target: ApprovalPushTarget) => boolean,
): Promise<DeliveryTarget[]> {
  const pairing = await listDevicePairing();
  const deviceIds = pairing.paired
    .filter((device) => {
      if (!isIosPlatform(device.platform) || !hasEffectivePairedDeviceRole(device, OPERATOR_ROLE)) {
        return false;
      }
      const operatorToken = device.tokens?.[OPERATOR_ROLE];
      if (
        !operatorToken ||
        operatorToken.revokedAtMs ||
        !roleScopesAllow({
          role: OPERATOR_ROLE,
          requestedScopes: [APPROVALS_SCOPE, READ_SCOPE],
          allowedScopes: operatorToken.scopes,
        })
      ) {
        return false;
      }
      return (
        isTargetVisible?.({
          deviceId: device.deviceId,
          scopes: operatorToken.scopes,
        }) ?? true
      );
    })
    .map((device) => device.deviceId);
  return deviceIds.length > 0 ? await loadApnsRegistrations(deviceIds) : [];
}

async function resolveDeliveryPlan(params: {
  approvalKind: ChannelApprovalKind;
  targets: DeliveryTarget[];
  log: GatewayLikeLogger;
}): Promise<DeliveryPlan> {
  const { targets } = params;
  if (targets.length === 0) {
    return { targets: [] };
  }

  const needsDirect = targets.some((target) => target.registration.transport === "direct");
  const needsRelay = targets.some((target) => target.registration.transport === "relay");

  let directAuth: ApnsAuthConfig | undefined;
  if (needsDirect) {
    const auth = await resolveApnsAuthConfigFromEnv(process.env);
    if (auth.ok) {
      directAuth = auth.value;
    } else {
      params.log.warn?.(
        `${params.approvalKind} approvals: iOS direct APNs auth unavailable: ${auth.error}`,
      );
    }
  }

  const relayConfigByNodeId = new Map<string, ApnsRelayConfig>();
  if (needsRelay) {
    for (const target of targets) {
      if (target.registration.transport !== "relay") {
        continue;
      }
      const relay = resolveApnsRelayConfigFromEnv(process.env, getRuntimeConfig().gateway, {
        registrationRelayOrigin: target.registration.relayOrigin,
      });
      if (relay.ok) {
        relayConfigByNodeId.set(target.nodeId, relay.value);
      } else {
        params.log.warn?.(
          `${params.approvalKind} approvals: iOS relay APNs config unavailable: ${relay.error}`,
        );
      }
    }
  }
  const relayConfig = relayConfigByNodeId.values().next().value;

  // Relay sends are grouped by one base URL because the wake helpers accept a
  // single relay config; targets on other relay origins are skipped this round.
  return {
    targets: targets.filter((target) =>
      target.registration.transport === "direct"
        ? Boolean(directAuth)
        : relayConfigByNodeId.has(target.nodeId) &&
          relayConfigByNodeId.get(target.nodeId)?.baseUrl === relayConfig?.baseUrl,
    ),
    directAuth,
    relayConfig,
  };
}

async function sendApprovalPushes(params: {
  approvalId: string;
  plan: DeliveryPlan;
  log: GatewayLikeLogger;
  approvalKind: ChannelApprovalKind;
  label: "request" | "cleanup";
  send: (params: ApprovalPushParams) => Promise<ApprovalPushSendResult>;
}): Promise<{ attempted: number; delivered: number }> {
  const gatewayDeviceId = (await loadOrCreateProcessDeviceIdentityAsync()).deviceId;
  // Stale registrations are cleared on both direct and relay failures so future
  // approval prompts do not keep targeting dead APNs device tokens.
  const results = await Promise.allSettled(
    params.plan.targets.map(async (target) => {
      const result = await params.send({
        ...approvalPushTransport(target, params.plan),
        approvalId: params.approvalId,
        gatewayDeviceId,
      });
      if (shouldClearStoredApnsRegistration({ registration: target.registration, result })) {
        await clearApnsRegistrationIfCurrent(target);
      }
      if (!result.ok) {
        params.log.warn?.(
          `${params.approvalKind} approvals: iOS ${params.label} push failed node=${target.nodeId} status=${result.status} reason=${result.reason ?? "unknown"}`,
        );
      }
      return result.ok;
    }),
  );
  for (const result of results) {
    if (params.label === "request" && result.status === "rejected") {
      const message = formatErrorMessage(result.reason);
      params.log.warn?.(
        `${params.approvalKind} approvals: iOS ${params.label} push threw error: ${message}`,
      );
    }
  }
  return {
    attempted: params.plan.targets.length,
    delivered: results.filter((result) => result.status === "fulfilled" && result.value).length,
  };
}

function createApprovalIosPushDelivery<TRequest extends ApprovalRequestLike>(params: {
  log: GatewayLikeLogger;
  driver: ApprovalPushDriver<TRequest>;
}) {
  const approvalDeliveriesById = new Map<string, ApprovalDeliveryState>();
  const pendingDeliveryStateById = new Map<string, Promise<ApprovalDeliveryState | null>>();

  const sendCleanupPushForApproval = async ({
    id: approvalId,
  }: ApprovalRequestLike): Promise<void> => {
    // A resolve/expire event can arrive before the request push plan finishes;
    // wait for the pending state so cleanup reaches the same target set.
    const deliveryState =
      approvalDeliveriesById.get(approvalId) ?? (await pendingDeliveryStateById.get(approvalId));
    approvalDeliveriesById.delete(approvalId);
    pendingDeliveryStateById.delete(approvalId);
    if (!deliveryState?.nodeIds.length) {
      params.log.debug?.(
        `${params.driver.approvalKind} approvals: iOS cleanup push skipped approvalId=${approvalId} reason=missing-targets`,
      );
      return;
    }
    await deliveryState.requestPushPromise;
    const plan = await resolveDeliveryPlan({
      approvalKind: params.driver.approvalKind,
      targets: await loadApnsRegistrations(deliveryState.nodeIds),
      log: params.log,
    });
    if (plan.targets.length === 0) {
      return;
    }
    await sendApprovalPushes({
      approvalId,
      plan,
      log: params.log,
      approvalKind: params.driver.approvalKind,
      label: "cleanup",
      send: params.driver.sendResolved,
    });
  };

  return {
    /** Sends the initial approval notification to visible iOS operator devices. */
    async handleRequested(
      request: TRequest,
      opts?: { isTargetVisible?: (target: ApprovalPushTarget) => boolean },
    ): Promise<boolean> {
      const deliveryStatePromise = (async (): Promise<ApprovalDeliveryState | null> => {
        const plan = await resolveDeliveryPlan({
          approvalKind: params.driver.approvalKind,
          targets: await resolvePairedTargets(opts?.isTargetVisible),
          log: params.log,
        });
        if (plan.targets.length === 0) {
          approvalDeliveriesById.delete(request.id);
          return null;
        }

        const deliveryState: ApprovalDeliveryState = {
          nodeIds: plan.targets.map((target) => target.nodeId),
          requestPushPromise: sendApprovalPushes({
            approvalId: request.id,
            plan,
            log: params.log,
            approvalKind: params.driver.approvalKind,
            label: "request",
            send: (push) => params.driver.sendRequested(request, push),
          }).catch((err: unknown) => {
            const message = formatErrorMessage(err);
            params.log.error?.(
              `${params.driver.approvalKind} approvals: iOS request push failed: ${message}`,
            );
            return { attempted: plan.targets.length, delivered: 0 };
          }),
        };
        approvalDeliveriesById.set(request.id, deliveryState);
        return deliveryState;
      })();
      pendingDeliveryStateById.set(request.id, deliveryStatePromise);

      const deliveryState = await deliveryStatePromise;
      if (pendingDeliveryStateById.get(request.id) === deliveryStatePromise) {
        pendingDeliveryStateById.delete(request.id);
      }
      if (!deliveryState) {
        return false;
      }

      const { attempted, delivered } = await deliveryState.requestPushPromise;
      if (attempted > 0 && delivered === 0) {
        params.log.warn?.(
          `${params.driver.approvalKind} approvals: iOS request push reached no devices approvalId=${request.id} attempted=${attempted}`,
        );
        if (
          approvalDeliveriesById.get(request.id)?.requestPushPromise ===
          deliveryState.requestPushPromise
        ) {
          approvalDeliveriesById.delete(request.id);
        }
        return false;
      }
      return true;
    },

    handleResolved: sendCleanupPushForApproval,
    handleExpired: sendCleanupPushForApproval,
  };
}

export function createExecApprovalIosPushDelivery(params: { log: GatewayLikeLogger }) {
  return createApprovalIosPushDelivery<ExecApprovalRequest>({
    log: params.log,
    driver: {
      approvalKind: "exec",
      sendRequested: (_request, push) => sendApnsExecApprovalAlert(push),
      sendResolved: sendApnsExecApprovalResolvedWake,
    },
  });
}

export function createPluginApprovalIosPushDelivery(params: { log: GatewayLikeLogger }) {
  return createApprovalIosPushDelivery<PluginApprovalRequest>({
    log: params.log,
    driver: {
      approvalKind: "plugin",
      sendRequested: (request, push) =>
        // Keep reviewer-only detail out of size-constrained lock-screen push payloads.
        sendApnsPluginApprovalAlert({
          ...push,
          title: request.request.title,
          description: request.request.description,
        }),
      sendResolved: sendApnsPluginApprovalResolvedWake,
    },
  });
}
