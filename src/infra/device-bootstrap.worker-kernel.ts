import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import {
  CONTROL_UI_OWNER_BOOTSTRAP_PROFILE,
  deviceBootstrapProfilesEqual,
  normalizeDeviceBootstrapHandoffProfile,
  normalizeDeviceBootstrapProfile,
  resolveBootstrapProfileScopesForRole,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
  type DeviceBootstrapCommand,
  type DeviceBootstrapOperations,
  type BoundDeviceBootstrapContext,
  type DeviceBootstrapBoundContextInput,
} from "./device-bootstrap.worker-types.js";
import { normalizeDevicePublicKeyBase64Url } from "./device-identity.js";
import { requestDevicePairingMutationAdmission } from "./device-pairing-mutation.worker.js";
import {
  confirmDevicePairSetupCompletionDeliveryInTransaction,
  consumeDeviceBootstrapTokenWithSetupCompletionInTransaction,
  loadDeviceBootstrapTokenRecords,
  withDevicePairingStoreDatabase,
  loadDevicePairSetupCompletionRecord,
  persistDeviceBootstrapTokenRecords as persistState,
  pruneExpiredDevicePairSetupCompletionRecords,
} from "./device-pairing-store.js";
import type { DeviceBootstrapTokenRecord } from "./device-pairing.types.js";
import { pruneExpiredPending } from "./pairing-files.js";
import { generatePairingToken, verifyPairingToken } from "./pairing-token.js";

// Outlive the credential itself: a client that waits for the full TTL still has
// to find its completion after the code it was showing has expired.
const DEVICE_PAIR_SETUP_COMPLETION_RETENTION_MS = 2 * DEVICE_BOOTSTRAP_TOKEN_TTL_MS;

type DeviceBootstrapStateFile = Record<string, DeviceBootstrapTokenRecord>;

function resolvePersistedBootstrapProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile(record.profile);
}

function resolvePersistedRedeemedProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile(record.redeemedProfile);
}

function resolvePersistedPendingProfile(
  record: Partial<DeviceBootstrapTokenRecord>,
): DeviceBootstrapProfile | null {
  return record.pendingProfile ? normalizeDeviceBootstrapProfile(record.pendingProfile) : null;
}

function resolveRequestedBootstrapProfile(params: {
  role: string;
  scopes: readonly string[];
  purpose?: DeviceBootstrapProfile["purpose"];
}): DeviceBootstrapProfile {
  return normalizeDeviceBootstrapProfile({
    roles: [params.role],
    scopes: resolveBootstrapProfileScopesForRole(params.role, params.scopes, params.purpose),
    purpose: params.purpose,
  });
}

function bootstrapProfileAllowsRequest(params: {
  allowedProfile: DeviceBootstrapProfile;
  requestedRole: string;
  requestedScopes: readonly string[];
}): boolean {
  return (
    params.allowedProfile.roles.includes(params.requestedRole) &&
    roleScopesAllow({
      role: params.requestedRole,
      requestedScopes: params.requestedScopes,
      allowedScopes: params.allowedProfile.scopes,
    })
  );
}

function bootstrapProfileSatisfiesProfile(params: {
  actualProfile: DeviceBootstrapProfile;
  requiredProfile: DeviceBootstrapProfile;
}): boolean {
  for (const requiredRole of params.requiredProfile.roles) {
    if (!params.actualProfile.roles.includes(requiredRole)) {
      return false;
    }
    const requiredScopes = resolveBootstrapProfileScopesForRole(
      requiredRole,
      params.requiredProfile.scopes,
      params.requiredProfile.purpose,
    );
    if (
      requiredScopes.length > 0 &&
      !bootstrapProfileAllowsRequest({
        allowedProfile: params.actualProfile,
        requestedRole: requiredRole,
        requestedScopes: requiredScopes,
      })
    ) {
      return false;
    }
  }
  return true;
}

function normalizeBootstrapPublicKey(publicKey: string): string {
  const trimmed = publicKey.trim();
  if (!trimmed) {
    return "";
  }
  // PEM/base64/base64url encodings for the same key must bind to one token identity.
  if (trimmed.includes("BEGIN") || /[+/=]/.test(trimmed)) {
    return normalizeDevicePublicKeyBase64Url(trimmed) ?? trimmed;
  }
  return trimmed;
}

function loadState(nowMs: number): DeviceBootstrapStateFile {
  const state = loadDeviceBootstrapTokenRecords();
  pruneExpiredPending(state, asDateTimestampMs(nowMs) ?? 0, DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
  return state;
}

function issueDeviceBootstrapTokenRecord(
  params: DeviceBootstrapOperations["bootstrap.issue"]["input"],
): { token: string; expiresAtMs: number } {
  const state = loadState(params.nowMs);
  const token = generatePairingToken();
  const issuedAtMs = asDateTimestampMs(params.nowMs);
  const expiresAtMs =
    issuedAtMs === undefined
      ? undefined
      : resolveExpiresAtMsFromDurationMs(DEVICE_BOOTSTRAP_TOKEN_TTL_MS, { nowMs: issuedAtMs });
  if (issuedAtMs === undefined || expiresAtMs === undefined) {
    throw new Error("Device bootstrap token expiry could not be resolved.");
  }
  const profile = params.profile;
  state[token] = {
    token,
    ...(params.setupId ? { setupId: params.setupId } : {}),
    ts: issuedAtMs,
    profile,
    redeemedProfile: normalizeDeviceBootstrapProfile(undefined),
    issuedAtMs,
  };
  persistState(state);
  return { token, expiresAtMs };
}

/** Reuse one environment-owned setup credential across provider replay. */
function ensureDevicePairSetupBootstrapToken(
  params: DeviceBootstrapOperations["bootstrap.ensure"]["input"],
): DeviceBootstrapOperations["bootstrap.ensure"]["output"] {
  const setupId = params.setupId.trim();
  if (!setupId) {
    throw new Error("Device setup id must be non-empty.");
  }
  const completion = loadDevicePairSetupCompletionRecord(setupId, params.nowMs);
  if (completion) {
    return { status: "completed", setupId, deviceId: completion.deviceId };
  }
  const state = loadState(params.nowMs);
  const existing = Object.values(state).find((record) => record.setupId === setupId);
  const profile = normalizeDeviceBootstrapHandoffProfile(params.profile);
  if (existing) {
    if (!deviceBootstrapProfilesEqual(existing.profile, profile)) {
      throw new Error("Device setup profile changed during replay.");
    }
    return {
      status: "pending",
      token: existing.token,
      expiresAtMs: existing.issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
      setupId,
    };
  }
  const issuedAtMs = asDateTimestampMs(params.nowMs);
  const expiresAtMs =
    issuedAtMs === undefined
      ? undefined
      : resolveExpiresAtMsFromDurationMs(DEVICE_BOOTSTRAP_TOKEN_TTL_MS, { nowMs: issuedAtMs });
  if (issuedAtMs === undefined || expiresAtMs === undefined) {
    throw new Error("Device bootstrap token expiry could not be resolved.");
  }
  const token = generatePairingToken();
  state[token] = {
    token,
    setupId,
    ts: issuedAtMs,
    profile,
    redeemedProfile: normalizeDeviceBootstrapProfile(undefined),
    issuedAtMs,
  };
  persistState(state);
  return { status: "pending", token, expiresAtMs, setupId };
}

/**
 * Record that credential delivery is not yet known. Only cloud-worker setup
 * keeps its device-bound bearer until delivery is confirmed, allowing the same
 * worker to retry when its credential-bearing response never arrives.
 */
function consumeDeviceBootstrapTokenWithSetupCompletion(
  params: DeviceBootstrapOperations["bootstrap.consume"]["input"],
): DeviceBootstrapOperations["bootstrap.consume"]["output"] {
  const nowMs = params.nowMs;
  return consumeDeviceBootstrapTokenWithSetupCompletionInTransaction({
    token: params.token,
    deviceId: params.deviceId,
    completedAtMs: params.completedAtMs,
    oldestValidIssuedAtMs: nowMs - DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
    // Retention follows the store clock rather than an injected event time.
    retentionNowMs: nowMs,
    retainUntilMs: nowMs + DEVICE_PAIR_SETUP_COMPLETION_RETENTION_MS,
    pairedDeviceMatches: (pairedDevice, record) => {
      requestDevicePairingMutationAdmission({
        kind: "bootstrap.consume",
        pairedDevice,
        issuedAtMs: record.issuedAtMs,
      });
      return true;
    },
  });
}

/** Confirm that the pairing client received the credential-bearing handoff response. */
function confirmDevicePairSetupCompletionDelivery(
  params: DeviceBootstrapOperations["bootstrap.confirm"]["input"],
): DeviceBootstrapOperations["bootstrap.confirm"]["output"] {
  return confirmDevicePairSetupCompletionDeliveryInTransaction({
    setupId: params.setupId,
    deviceId: params.deviceId,
    nowMs: params.nowMs,
  });
}

/**
 * Read the terminal outcome for one setup credential, or null while none is
 * recorded. Shares this module's lock with issuance and revocation so a status
 * query never observes a setup mid-settlement.
 */
function readDevicePairSetupCompletion(
  params: DeviceBootstrapOperations["bootstrap.readCompletion"]["input"],
): DeviceBootstrapOperations["bootstrap.readCompletion"]["output"] {
  return loadDevicePairSetupCompletionRecord(params.setupId, params.nowMs);
}

/** Remove retained setup outcomes independently of status requests or later pairings. */
function pruneExpiredDevicePairSetupCompletions(
  params: DeviceBootstrapOperations["bootstrap.prune"]["input"],
): DeviceBootstrapOperations["bootstrap.prune"]["output"] {
  return pruneExpiredDevicePairSetupCompletionRecords(params.nowMs);
}

/** Remove every outstanding bootstrap token from the pairing state file. */
function clearDeviceBootstrapTokens(
  params: DeviceBootstrapOperations["bootstrap.clear"]["input"],
): DeviceBootstrapOperations["bootstrap.clear"]["output"] {
  const state = loadState(params.nowMs);
  const removed = Object.keys(state).length;
  persistState({});
  return { removed };
}

/** Revoke one bootstrap token and return its record for best-effort restore flows. */
function revokeDeviceBootstrapToken(
  params: DeviceBootstrapOperations["bootstrap.revoke"]["input"],
): DeviceBootstrapOperations["bootstrap.revoke"]["output"] {
  const providedToken = params.token.trim();
  if (!providedToken) {
    return { removed: false };
  }
  const state = loadState(params.nowMs);
  const found = Object.entries(state).find(([, candidate]) =>
    verifyPairingToken(providedToken, candidate.token),
  );
  if (!found) {
    return { removed: false };
  }
  const [tokenKey, record] = found;
  delete state[tokenKey];
  persistState(state);
  return { removed: true, record };
}

/** Revoke bootstrap credentials inside the rejected request's pairing transaction. */
export function revokeDeviceBootstrapTokensForDeviceInDatabase(
  database: OpenClawStateDatabase,
  params: { deviceId: string; publicKey: string; nowMs: number },
): void {
  withDevicePairingStoreDatabase(database, () => {
    const deviceId = params.deviceId.trim();
    const publicKey = normalizeBootstrapPublicKey(params.publicKey);
    if (!deviceId || !publicKey) {
      return;
    }
    const state = loadState(params.nowMs);
    let removed = false;
    for (const [tokenKey, record] of Object.entries(state)) {
      const recordPublicKey =
        typeof record.publicKey === "string"
          ? normalizeBootstrapPublicKey(record.publicKey)
          : undefined;
      if (record.deviceId?.trim() === deviceId && recordPublicKey === publicKey) {
        delete state[tokenKey];
        removed = true;
      }
    }
    if (removed) {
      persistState(state);
    }
  });
}

/** Restore an uncorrelated bootstrap bearer when its credential response was not delivered. */
function restoreGenericDeviceBootstrapToken(
  params: DeviceBootstrapOperations["bootstrap.restore"]["input"],
): DeviceBootstrapOperations["bootstrap.restore"]["output"] {
  if (params.record.setupId) {
    // Correlated setup credentials are settled only by their exact completion owner.
    return false;
  }
  const state = loadState(params.nowMs);
  state[params.record.token] = params.record;
  persistState(state);
  return true;
}

/** Record that one role/scope leg of a multi-role bootstrap handoff was redeemed. */
function redeemDeviceBootstrapTokenProfile(
  params: DeviceBootstrapOperations["bootstrap.redeem"]["input"],
): DeviceBootstrapOperations["bootstrap.redeem"]["output"] {
  const providedToken = params.token.trim();
  if (!providedToken) {
    return { recorded: false, fullyRedeemed: false };
  }
  const state = loadState(params.nowMs);
  const found = Object.entries(state).find(([, candidate]) =>
    verifyPairingToken(providedToken, candidate.token),
  );
  if (!found) {
    return { recorded: false, fullyRedeemed: false };
  }
  const [tokenKey, record] = found;
  const issuedProfile = resolvePersistedBootstrapProfile(record);
  requestDevicePairingMutationAdmission({
    kind: "bootstrap.token",
    issuedAtMs: record.issuedAtMs,
  });
  const pendingProfile = resolvePersistedPendingProfile(record);
  // Keep a pending profile until all requested roles/scopes from that handshake are redeemed.
  const redeemedProfile = normalizeDeviceBootstrapProfile({
    roles: [...resolvePersistedRedeemedProfile(record).roles, params.role],
    scopes: [
      ...resolvePersistedRedeemedProfile(record).scopes,
      ...resolveBootstrapProfileScopesForRole(params.role, params.scopes, issuedProfile.purpose),
    ],
    purpose: issuedProfile.purpose,
  });
  const nextPendingProfile =
    pendingProfile &&
    !bootstrapProfileSatisfiesProfile({
      actualProfile: redeemedProfile,
      requiredProfile: pendingProfile,
    })
      ? pendingProfile
      : undefined;
  const nextRecord: DeviceBootstrapTokenRecord = {
    ...record,
    profile: issuedProfile,
    redeemedProfile,
  };
  if (nextPendingProfile) {
    nextRecord.pendingProfile = nextPendingProfile;
  } else {
    delete nextRecord.pendingProfile;
  }
  state[tokenKey] = nextRecord;
  persistState(state);
  return {
    recorded: true,
    fullyRedeemed: bootstrapProfileSatisfiesProfile({
      actualProfile: redeemedProfile,
      requiredProfile: issuedProfile,
    }),
  };
}

/** Verify a bootstrap token, bind it to the first device identity, and stage requested scopes. */
function verifyDeviceBootstrapToken(
  params: DeviceBootstrapOperations["bootstrap.verify"]["input"],
): DeviceBootstrapOperations["bootstrap.verify"]["output"] {
  const state = loadState(params.nowMs);
  const providedToken = params.token.trim();
  if (!providedToken) {
    return { ok: false, reason: "bootstrap_token_invalid" };
  }
  const found = Object.entries(state).find(([, candidate]) =>
    verifyPairingToken(providedToken, candidate.token),
  );
  if (!found) {
    return { ok: false, reason: "bootstrap_token_invalid" };
  }
  const [tokenKey, record] = found;

  const deviceId = params.deviceId.trim();
  const publicKey = normalizeBootstrapPublicKey(params.publicKey);
  const role = params.role.trim();
  if (!deviceId || !publicKey || !role) {
    return { ok: false, reason: "bootstrap_token_invalid" };
  }
  const allowedProfile = resolvePersistedBootstrapProfile(record);
  const requestedProfile = resolveRequestedBootstrapProfile({
    role,
    scopes: params.scopes,
    purpose: allowedProfile.purpose,
  });
  // Fail closed for any attempt to redeem the token outside the issued
  // role/scope allowlist before binding it to a concrete device identity.
  if (
    allowedProfile.roles.length === 0 ||
    (deviceBootstrapProfilesEqual(allowedProfile, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE) &&
      !deviceBootstrapProfilesEqual(requestedProfile, CONTROL_UI_OWNER_BOOTSTRAP_PROFILE)) ||
    !bootstrapProfileAllowsRequest({
      allowedProfile,
      requestedRole: role,
      requestedScopes: params.scopes,
    })
  ) {
    return { ok: false, reason: "bootstrap_token_invalid" };
  }

  requestDevicePairingMutationAdmission({
    kind: "bootstrap.token",
    issuedAtMs: record.issuedAtMs,
  });

  const boundDeviceId = record.deviceId?.trim();
  const boundPublicKey =
    typeof record.publicKey === "string"
      ? normalizeBootstrapPublicKey(record.publicKey)
      : undefined;
  if (boundDeviceId || boundPublicKey) {
    if (boundDeviceId !== deviceId || boundPublicKey !== publicKey) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    const pendingProfile = resolvePersistedPendingProfile(record);
    if (pendingProfile && !deviceBootstrapProfilesEqual(pendingProfile, requestedProfile)) {
      return { ok: false, reason: "bootstrap_token_invalid" };
    }
    state[tokenKey] = {
      ...record,
      profile: allowedProfile,
      pendingProfile: pendingProfile ?? requestedProfile,
      deviceId,
      publicKey,
      lastUsedAtMs: params.nowMs,
    };
    persistState(state);
    return { ok: true };
  }

  state[tokenKey] = {
    ...record,
    profile: allowedProfile,
    pendingProfile: requestedProfile,
    deviceId,
    publicKey,
    lastUsedAtMs: params.nowMs,
  };
  persistState(state);
  return { ok: true };
}

export function getBoundDeviceBootstrapContextFromRecords(
  state: DeviceBootstrapStateFile,
  params: DeviceBootstrapBoundContextInput,
): BoundDeviceBootstrapContext | null {
  pruneExpiredPending(state, asDateTimestampMs(params.nowMs) ?? 0, DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
  const providedToken = params.token.trim();
  if (!providedToken) {
    return null;
  }
  const found = Object.entries(state).find(([, candidate]) =>
    verifyPairingToken(providedToken, candidate.token),
  );
  if (!found) {
    return null;
  }
  const [, record] = found;
  const deviceId = params.deviceId.trim();
  const publicKey = normalizeBootstrapPublicKey(params.publicKey);
  if (!deviceId || !publicKey) {
    return null;
  }
  const recordPublicKey =
    typeof record.publicKey === "string"
      ? normalizeBootstrapPublicKey(record.publicKey)
      : undefined;
  if (record.deviceId?.trim() !== deviceId || recordPublicKey !== publicKey) {
    return null;
  }
  return {
    profile: resolvePersistedBootstrapProfile(record),
    ...(record.setupId ? { setupId: record.setupId } : {}),
  };
}

export function executeDeviceBootstrapMutation(
  command: DeviceBootstrapCommand,
  database: OpenClawStateDatabase,
): DeviceBootstrapOperations[keyof DeviceBootstrapOperations]["output"] {
  return withDevicePairingStoreDatabase(database, () => {
    switch (command.type) {
      case "bootstrap.issue":
        return issueDeviceBootstrapTokenRecord(command.input);
      case "bootstrap.ensure":
        return ensureDevicePairSetupBootstrapToken(command.input);
      case "bootstrap.consume":
        return consumeDeviceBootstrapTokenWithSetupCompletion(command.input);
      case "bootstrap.confirm":
        return confirmDevicePairSetupCompletionDelivery(command.input);
      case "bootstrap.readCompletion":
        return readDevicePairSetupCompletion(command.input);
      case "bootstrap.prune":
        return pruneExpiredDevicePairSetupCompletions(command.input);
      case "bootstrap.clear":
        return clearDeviceBootstrapTokens(command.input);
      case "bootstrap.revoke":
        return revokeDeviceBootstrapToken(command.input);
      case "bootstrap.restore":
        return restoreGenericDeviceBootstrapToken(command.input);
      case "bootstrap.redeem":
        return redeemDeviceBootstrapTokenProfile(command.input);
      case "bootstrap.verify":
        return verifyDeviceBootstrapToken(command.input);
    }
    command satisfies never;
    throw new Error("Unsupported device bootstrap command");
  });
}
