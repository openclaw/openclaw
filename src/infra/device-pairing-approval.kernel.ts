import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import {
  resolveDeviceProfileRoleScopes,
  resolveDeviceProfileScopes,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import {
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
} from "../shared/operator-scope-compat.js";
// Owner and bootstrap approval flows for pending device pairing requests.
import type {
  DevicePairingAccessMetadata,
  ApproveDevicePairingResult,
  DevicePairingApprovalOptions,
  DeviceBootstrapApprovalOptions,
} from "./device-pairing-core.types.js";
import {
  clearNodePairingGenerationState,
  resolveNodePairingGeneration,
} from "./device-pairing-identity.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import {
  loadDevicePairingStateForMutation,
  mergeDevicePairingRoles,
  mergeDevicePairingScopes,
  preserveDeviceRoleScopes,
  resolveRequestedDeviceRoles,
  sameDevicePairingStringSet,
} from "./device-pairing-state.kernel.js";
import type { DevicePairingStoreState } from "./device-pairing-store.js";
import { persistDevicePairingStoreState as persistState } from "./device-pairing-store.js";
import { createDeviceAuthToken, resolveRoleTokenScopes } from "./device-pairing-token-utils.js";
import type {
  DeviceAuthToken,
  DevicePairingPendingRequest,
  PairedDevice,
  PairedDeviceApprovalKind,
} from "./device-pairing.types.js";

const OPERATOR_ROLE = "operator";
const OPERATOR_SCOPE_PREFIX = "operator.";

// Interactive approvals must stay sticky: a later silent repair/re-approve of the
// same device id cannot downgrade an owner/bootstrap record into prune-eligible
// state. Pre-provenance records (approvedVia undefined) may have been approved by
// an owner, so a non-interactive re-approve must keep them protected (undefined).
function mergeApprovalKind(
  existing: PairedDevice | undefined,
  incoming: PairedDeviceApprovalKind,
): PairedDeviceApprovalKind | undefined {
  if (incoming === "owner" || !existing) {
    return incoming;
  }
  if (existing.approvedVia === undefined) {
    return incoming === "bootstrap" ? "bootstrap" : undefined;
  }
  if (existing.approvedVia === "owner" || existing.approvedVia === "bootstrap") {
    return existing.approvedVia;
  }
  return incoming;
}

function buildApprovedPairedDevice(params: {
  pending: DevicePairingPendingRequest;
  existing: PairedDevice | undefined;
  roles: string[] | undefined;
  approvedScopes: string[] | undefined;
  tokens: Record<string, DeviceAuthToken>;
  now: number;
  approvedVia: PairedDeviceApprovalKind;
  accessMetadata?: DevicePairingAccessMetadata;
}): PairedDevice {
  return {
    deviceId: params.pending.deviceId,
    publicKey: params.pending.publicKey,
    displayName: params.accessMetadata?.displayName ?? params.pending.displayName,
    platform: params.pending.platform,
    deviceFamily: params.pending.deviceFamily,
    clientId: params.pending.clientId,
    clientMode: params.pending.clientMode,
    browserOrigin: params.pending.browserOrigin,
    role: params.pending.role,
    roles: params.roles,
    scopes: params.approvedScopes,
    approvedScopes: params.approvedScopes,
    remoteIp: params.accessMetadata?.remoteIp ?? params.pending.remoteIp,
    tokens: params.tokens,
    approvedVia: mergeApprovalKind(params.existing, params.approvedVia),
    // Node capability approvals ride on the device record; device repair or
    // role re-approval must not silently revoke an approved node surface.
    ...(params.existing?.nodeSurface ? { nodeSurface: params.existing.nodeSurface } : {}),
    ...(params.existing?.pendingNodeSurface
      ? { pendingNodeSurface: params.existing.pendingNodeSurface }
      : {}),
    // Operator-assigned label is owner-side state; device repair or role
    // re-approval must not silently drop it.
    ...(params.existing?.operatorLabel ? { operatorLabel: params.existing.operatorLabel } : {}),
    createdAtMs: params.existing?.createdAtMs ?? params.now,
    approvedAtMs: params.now,
    lastSeenAtMs: params.accessMetadata?.lastSeenAtMs ?? params.existing?.lastSeenAtMs,
    lastSeenReason: params.accessMetadata?.lastSeenReason ?? params.existing?.lastSeenReason,
  };
}

function commitApprovedDevicePairing(params: {
  state: DevicePairingStoreState;
  requestId: string;
  device: PairedDevice;
  baseDir?: string;
}): Extract<ApproveDevicePairingResult, { status: "approved" }> {
  const { state, requestId, device, baseDir } = params;
  const existing = state.pairedByDeviceId[device.deviceId];
  // The approved device preserves nodeSurface by reference, so capture its
  // generation before cleanup mutates generation-owned fields.
  const previousNodeGeneration = resolveNodePairingGeneration(existing ?? null);
  const nextNodeGeneration = resolveNodePairingGeneration(device);
  const nodePairingGenerationChanged = Boolean(
    previousNodeGeneration && previousNodeGeneration.key !== nextNodeGeneration?.key,
  );
  clearNodePairingGenerationState(device, previousNodeGeneration);
  const installationIdentityChanged = Boolean(existing && existing.publicKey !== device.publicKey);
  delete state.pendingById[requestId];
  state.pairedByDeviceId[device.deviceId] = device;
  persistState(
    state,
    baseDir,
    "both",
    installationIdentityChanged ? { clearApnsNodeIds: [device.deviceId] } : undefined,
  );
  return {
    status: "approved",
    requestId,
    device,
    ...(nodePairingGenerationChanged ? { nodePairingGenerationChanged: true as const } : {}),
  };
}

function resolveApprovedTokenScopes(params: {
  role: string;
  pending: DevicePairingPendingRequest;
  existingToken?: DeviceAuthToken;
  approvedScopes?: string[];
  existing?: PairedDevice;
}): string[] {
  const pendingScopes = resolveRoleTokenScopes(params.role, params.pending.scopes);
  if (pendingScopes.length > 0) {
    const approvedBaseline = resolveRoleTokenScopes(
      params.role,
      params.existing?.approvedScopes ?? params.existing?.scopes,
    );
    const requestedScopeDelta =
      params.existingToken && approvedBaseline.length > 0
        ? pendingScopes.filter((scope) => !approvedBaseline.includes(scope))
        : pendingScopes;
    if (requestedScopeDelta.length === 0 && params.existingToken) {
      return resolveRoleTokenScopes(params.role, params.existingToken.scopes);
    }
    return resolveRoleTokenScopes(
      params.role,
      mergeDevicePairingScopes(params.existingToken?.scopes, requestedScopeDelta),
    );
  }
  return resolveRoleTokenScopes(
    params.role,
    params.existingToken?.scopes ??
      params.approvedScopes ??
      params.existing?.approvedScopes ??
      params.existing?.scopes,
  );
}

function withPendingDevicePairingApproval(
  requestId: string,
  nowMs: number,
  baseDir: string | undefined,
  approve: (
    state: DevicePairingStoreState,
    pending: DevicePairingPendingRequest,
    existing: PairedDevice | undefined,
  ) => ApproveDevicePairingResult,
): ApproveDevicePairingResult {
  const state = loadDevicePairingStateForMutation(nowMs, baseDir);
  const pending = state.pendingById[requestId];
  if (!pending) {
    return null;
  }
  const existing = state.pairedByDeviceId[pending.deviceId];
  requestDevicePairingMutationAdmission({ kind: "pairing-approval", pending, existing });
  return approve(state, pending, existing);
}

/** Approve an authoritative pending row inside the admitted pairing transaction. */
export function approveDevicePairingInWorker(
  requestId: string,
  options: Omit<DevicePairingApprovalOptions, "isApprovalCurrent"> | undefined,
  nowMs: number,
  baseDir?: string,
): ApproveDevicePairingResult {
  return withPendingDevicePairingApproval(
    requestId,
    nowMs,
    baseDir,
    (state, pendingRecord, existing) => {
      const autoApproveScopes = options?.autoApproveNewDeviceScopes;
      const requestedRoles = resolveRequestedDeviceRoles(pendingRecord);
      // Trusted-proxy connects carry an SSO-authenticated user, and the connect
      // handshake has already proven possession of the pending public key. A
      // matching key on the paired record is therefore the same physical device
      // re-requesting (typically a scope upgrade) and may auto-approve; a key
      // mismatch is a real repair — possibly a deviceId squat — and stays a
      // manual owner decision.
      const trustedProxySameKeyDevice =
        options?.approvedVia === "trusted-proxy" &&
        existing !== undefined &&
        existing.publicKey === pendingRecord.publicKey;
      if (
        autoApproveScopes &&
        (((pendingRecord.isRepair || existing) && !trustedProxySameKeyDevice) ||
          !sameDevicePairingStringSet(requestedRoles, [OPERATOR_ROLE]))
      ) {
        return null;
      }
      const pending = autoApproveScopes
        ? { ...pendingRecord, scopes: [...autoApproveScopes] }
        : pendingRecord;
      const requestedScopes = normalizeDeviceAuthScopes(pending.scopes);
      const roleMismatchScope = resolveScopeOutsideRequestedRoles({
        requestedRoles,
        requestedScopes,
      });
      if (roleMismatchScope) {
        return {
          status: "forbidden",
          reason: "scope-outside-requested-roles",
          scope: roleMismatchScope,
        };
      }
      const now = nowMs;
      const roles = mergeDevicePairingRoles(
        existing?.roles,
        existing?.role,
        pending.roles,
        pending.role,
      );
      const approvedScopes = mergeDevicePairingScopes(
        existing?.approvedScopes ?? existing?.scopes,
        pending.scopes,
      );
      const tokens = existing?.tokens ? { ...existing.tokens } : {};
      const nextTokenScopesByRole = new Map<string, string[]>();
      for (const roleForToken of requestedRoles) {
        const existingToken = tokens[roleForToken];
        const nextScopes = resolveApprovedTokenScopes({
          role: roleForToken,
          pending,
          existingToken,
          approvedScopes,
          existing,
        });
        nextTokenScopesByRole.set(roleForToken, nextScopes);
        if (roleForToken === OPERATOR_ROLE && nextScopes.length > 0) {
          const callerRequiredScopes =
            mergeDevicePairingScopes(
              resolveRoleTokenScopes(roleForToken, pending.scopes),
              nextScopes,
            ) ?? nextScopes;
          if (!options?.callerScopes) {
            return {
              status: "forbidden",
              reason: "caller-scopes-required",
              scope: callerRequiredScopes[0],
            };
          }
          const missingScope = resolveMissingRequestedScope({
            role: OPERATOR_ROLE,
            requestedScopes: callerRequiredScopes,
            allowedScopes: options.callerScopes,
          });
          if (missingScope) {
            return { status: "forbidden", reason: "caller-missing-scope", scope: missingScope };
          }
        }
      }
      for (const [roleForToken, nextScopes] of nextTokenScopesByRole) {
        const existingToken = tokens[roleForToken];
        const tokenNow = nowMs;
        tokens[roleForToken] = createDeviceAuthToken({
          role: roleForToken,
          scopes: nextScopes,
          existing: existingToken,
          preserveExistingIssuer: true,
          now: tokenNow,
          rotatedAtMs: existingToken ? tokenNow : undefined,
        });
      }
      const device = buildApprovedPairedDevice({
        pending,
        existing,
        roles,
        approvedScopes,
        tokens,
        now,
        approvedVia: options?.approvedVia ?? "owner",
        accessMetadata: options?.accessMetadata,
      });
      return commitApprovedDevicePairing({ state, requestId, device, baseDir });
    },
  );
}

/** Approve one bounded bootstrap grant inside the admitted pairing transaction. */
export function approveBootstrapDevicePairingInWorker(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  options: Pick<DeviceBootstrapApprovalOptions, "accessMetadata"> | undefined,
  nowMs: number,
  baseDir?: string,
): { result: ApproveDevicePairingResult; replacedRoles: string[] } {
  let replacedRoles: string[] = [];
  const approvedRoles = mergeDevicePairingRoles(bootstrapProfile.roles) ?? [];
  const approvedScopes = resolveDeviceProfileScopes(bootstrapProfile, approvedRoles);
  const result = withPendingDevicePairingApproval(
    requestId,
    nowMs,
    baseDir,
    (state, pending, existing) => {
      const requestedRoles = resolveRequestedDeviceRoles(pending);
      const missingRole = requestedRoles.find((role) => !approvedRoles.includes(role));
      if (missingRole) {
        return { status: "forbidden", reason: "bootstrap-role-not-allowed", role: missingRole };
      }
      const requestedOperatorScopes = normalizeDeviceAuthScopes(pending.scopes).filter((scope) =>
        scope.startsWith(OPERATOR_SCOPE_PREFIX),
      );
      const missingScope = resolveMissingRequestedScope({
        role: OPERATOR_ROLE,
        requestedScopes: requestedOperatorScopes,
        allowedScopes: approvedScopes,
      });
      if (missingScope) {
        return { status: "forbidden", reason: "bootstrap-scope-not-allowed", scope: missingScope };
      }

      const now = nowMs;
      const grantedRoles = requestedRoles;
      const grantedScopes = resolveDeviceProfileScopes(
        bootstrapProfile,
        grantedRoles,
        pending.scopes ?? [],
      );
      const grantedRoleSet = new Set(grantedRoles);
      const preservedExistingScopes = (
        mergeDevicePairingRoles(existing?.roles, existing?.role) ?? []
      ).flatMap((existingRole) =>
        grantedRoleSet.has(existingRole)
          ? []
          : preserveDeviceRoleScopes(existingRole, existing?.approvedScopes ?? existing?.scopes),
      );
      const roles = mergeDevicePairingRoles(
        existing?.roles,
        existing?.role,
        pending.roles,
        pending.role,
      );
      const nextApprovedScopes = mergeDevicePairingScopes(preservedExistingScopes, grantedScopes);
      const tokens = existing?.tokens ? { ...existing.tokens } : {};
      for (const roleForToken of grantedRoles) {
        const existingToken = tokens[roleForToken];
        const tokenScopes =
          roleForToken === OPERATOR_ROLE
            ? resolveDeviceProfileRoleScopes(bootstrapProfile, roleForToken, grantedScopes)
            : [];
        tokens[roleForToken] = createDeviceAuthToken({
          role: roleForToken,
          scopes: tokenScopes,
          existing: existingToken,
          now,
          ...(existingToken ? { rotatedAtMs: now } : {}),
        });
      }

      const device = buildApprovedPairedDevice({
        pending,
        existing,
        roles,
        approvedScopes: nextApprovedScopes,
        tokens,
        now,
        approvedVia: "bootstrap",
        accessMetadata: options?.accessMetadata,
      });
      const approved = commitApprovedDevicePairing({ state, requestId, device, baseDir });
      replacedRoles = grantedRoles.filter((role) => existing?.tokens?.[role]);
      return approved;
    },
  );
  return { result, replacedRoles };
}
