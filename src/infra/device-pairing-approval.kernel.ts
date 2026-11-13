import { normalizeDeviceAuthScopes } from "../shared/device-auth.js";
import {
  deviceBootstrapProfilesEqual,
  resolveDeviceProfileRoleScopes,
  resolveDeviceProfileScopes,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import {
  resolveMissingRequestedScope,
  resolveScopeOutsideRequestedRoles,
} from "../shared/operator-scope-compat.js";
import { requireDeviceBootstrapSourceInWorker } from "./device-bootstrap.worker-kernel.js";
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
import { reusablePairedDeviceToken } from "./device-pairing-token-policy.js";
import { createDeviceAuthToken, resolveRoleTokenScopes } from "./device-pairing-token-utils.js";
import type {
  DeviceAuthToken,
  DevicePairingPendingRequest,
  PairedDevice,
  PairedDeviceApprovalKind,
} from "./device-pairing.types.js";
import { assertBootstrapPersonInDatabase } from "./device-profile-enrollment.worker.js";
import type { EngineConnection } from "./sql-connection.js";

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

function mergeApprovalRoles(
  existing: PairedDevice | undefined,
  pending: DevicePairingPendingRequest,
): string[] | undefined {
  return mergeDevicePairingRoles(existing?.roles, existing?.role, pending.roles, pending.role);
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
  // A replaced installation does not inherit the old node key's role provenance.
  if (
    params.existing &&
    params.existing.publicKey !== params.pending.publicKey &&
    params.tokens.node
  ) {
    delete params.tokens.node.approval;
  }
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
    // Personal identity belongs to the proven installation, not a reusable device ID.
    ...(params.existing?.publicKey === params.pending.publicKey &&
    params.existing.operatorProfileId !== undefined
      ? { operatorProfileId: params.existing.operatorProfileId }
      : {}),
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
}): Extract<ApproveDevicePairingResult, { status: "approved" }> {
  const { state, requestId, device } = params;
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
    undefined,
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
    // A revoked token grants nothing to keep: re-issue what this request asks for, so a
    // narrower reconnect after sign-out (OCF-495) is not held to the revoked grant.
    const liveToken = params.existingToken?.revokedAtMs ? undefined : params.existingToken;
    const approvedBaseline = resolveRoleTokenScopes(
      params.role,
      params.existing?.approvedScopes ?? params.existing?.scopes,
    );
    const requestedScopeDelta =
      liveToken && approvedBaseline.length > 0
        ? pendingScopes.filter((scope) => !approvedBaseline.includes(scope))
        : pendingScopes;
    if (requestedScopeDelta.length === 0 && liveToken) {
      return resolveRoleTokenScopes(params.role, liveToken.scopes);
    }
    return resolveRoleTokenScopes(
      params.role,
      mergeDevicePairingScopes(liveToken?.scopes, requestedScopeDelta),
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
  approve: (
    state: DevicePairingStoreState,
    pending: DevicePairingPendingRequest,
    existing: PairedDevice | undefined,
  ) => ApproveDevicePairingResult,
): ApproveDevicePairingResult {
  const state = loadDevicePairingStateForMutation(nowMs);
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
  // Issuer selection belongs to the worker, not public SDK approval options.
  tokenIssuer?: DeviceAuthToken["issuer"],
): ApproveDevicePairingResult {
  return withPendingDevicePairingApproval(requestId, nowMs, (state, pendingRecord, existing) => {
    const autoApproveScopes = options?.autoApproveNewDeviceScopes;
    const requestedRoles = resolveRequestedDeviceRoles(pendingRecord);
    if (
      options?.operatorProfileId !== undefined &&
      (!requestedRoles.includes(OPERATOR_ROLE) || (options.approvedVia ?? "owner") !== "owner")
    ) {
      throw new Error("Only explicit operator approval may associate a person");
    }
    // Trusted proxy and remote ingress connects carry authenticated front-door
    // authority, and the handshake has proven possession of the pending key. A
    // matching key on the paired record is therefore the same physical device
    // re-requesting (typically a scope upgrade) and may auto-approve; a key
    // mismatch is a real repair — possibly a deviceId squat — and stays a
    // manual owner decision.
    const trustedIngressSameKeyDevice =
      (options?.approvedVia === "trusted-proxy" || options?.approvedVia === "remote-ingress") &&
      existing !== undefined &&
      existing.publicKey === pendingRecord.publicKey;
    if (
      autoApproveScopes &&
      (((pendingRecord.isRepair || existing) && !trustedIngressSameKeyDevice) ||
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
    const roles = mergeApprovalRoles(existing, pending);
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
        issuer: tokenIssuer,
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
    if (options?.operatorProfileId !== undefined) {
      device.operatorProfileId = options.operatorProfileId;
      requestDevicePairingMutationAdmission({
        kind: "pairing-profile-enrollment",
        deviceId: device.deviceId,
        profileId: options.operatorProfileId,
      });
    }
    return commitApprovedDevicePairing({ state, requestId, device });
  });
}

/** Approve one bounded bootstrap grant inside the admitted pairing transaction. */
export function approveBootstrapDevicePairingInWorker(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  options: Pick<DeviceBootstrapApprovalOptions, "accessMetadata" | "bootstrapSource"> | undefined,
  nowMs: number,
  db: EngineConnection,
): { result: ApproveDevicePairingResult; replacedRoles: string[] } {
  let replacedRoles: string[] = [];
  const approvedRoles = mergeDevicePairingRoles(bootstrapProfile.roles) ?? [];
  const approvedScopes = resolveDeviceProfileScopes(bootstrapProfile, approvedRoles);
  const result = withPendingDevicePairingApproval(requestId, nowMs, (state, pending, existing) => {
    assertBootstrapPersonInDatabase(db, bootstrapProfile);
    const source = options?.bootstrapSource;
    if (source) {
      const bound = requireDeviceBootstrapSourceInWorker(source, pending, nowMs);
      const sameExistingPerson =
        existing?.publicKey === pending.publicKey &&
        existing?.operatorProfileId === bootstrapProfile.operatorProfileId;
      if (
        (bound.operatorProfileId !== bootstrapProfile.operatorProfileId &&
          !(bound.operatorProfileId === undefined && sameExistingPerson)) ||
        !deviceBootstrapProfilesEqual(bound, {
          ...bootstrapProfile,
          operatorProfileId: bound.operatorProfileId,
        })
      ) {
        throw new Error("Bootstrap approval source no longer matches its exact person and device");
      }
    } else if (
      bootstrapProfile.operatorProfileId !== undefined &&
      (existing?.operatorProfileId !== bootstrapProfile.operatorProfileId ||
        existing.publicKey !== pending.publicKey)
    ) {
      throw new Error(
        "Person-selected bootstrap approval requires its exact server-held credential source",
      );
    }
    if (
      bootstrapProfile.operatorProfileId !== undefined &&
      existing?.operatorProfileId &&
      existing.operatorProfileId !== bootstrapProfile.operatorProfileId
    ) {
      throw new Error(
        "Bootstrap cannot replace a represented person; use explicit device profile enrollment",
      );
    }
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
    const roles = mergeApprovalRoles(existing, pending);
    const nextApprovedScopes = mergeDevicePairingScopes(preservedExistingScopes, grantedScopes);
    const tokens = existing?.tokens ? { ...existing.tokens } : {};
    for (const roleForToken of grantedRoles) {
      const existingToken = tokens[roleForToken];
      const tokenScopes =
        roleForToken === OPERATOR_ROLE
          ? resolveDeviceProfileRoleScopes(bootstrapProfile, roleForToken, grantedScopes)
          : [];
      // Selecting a person changes only operator authority. An active node
      // keeps its independent credential and provenance, even on node-first setup.
      if (
        bootstrapProfile.operatorProfileId !== undefined &&
        roleForToken === "node" &&
        existing?.publicKey === pending.publicKey &&
        reusablePairedDeviceToken(existing, {
          role: roleForToken,
          scopes: tokenScopes,
          issuer: existingToken?.issuer,
        })
      ) {
        continue;
      }
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
    if (grantedRoles.includes(OPERATOR_ROLE) && bootstrapProfile.operatorProfileId !== undefined) {
      device.operatorProfileId = bootstrapProfile.operatorProfileId;
    }
    const approved = commitApprovedDevicePairing({ state, requestId, device });
    replacedRoles = grantedRoles.filter((role) => {
      const previous = existing?.tokens?.[role];
      return previous !== undefined && previous.token !== tokens[role]?.token;
    });
    return approved;
  });
  return { result, replacedRoles };
}
