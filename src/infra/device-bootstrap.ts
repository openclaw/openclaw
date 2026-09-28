// Bootstraps device identity and trust state on first run.
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  normalizeDeviceBootstrapHandoffProfile,
  normalizeDeviceBootstrapProfile,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
  type DeviceBootstrapProfile,
  type DeviceBootstrapProfileInput,
} from "../shared/device-bootstrap-profile.js";
import {
  DEVICE_BOOTSTRAP_TOKEN_TTL_MS,
  type DeviceBootstrapMutationAdmission,
  type DeviceBootstrapOperations,
} from "./device-bootstrap.worker-types.js";
import { loadBoundDeviceBootstrapContextReadOnly } from "./device-pairing-store-readonly.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "./device-pairing-worker.js";
import type { PairedDevice } from "./device-pairing.types.js";
import { createAsyncLock } from "./pairing-files.js";

const withLock = createAsyncLock();
const log = createSubsystemLogger("device-bootstrap");

function assertBootstrapTokenCurrent(facts: DeviceBootstrapMutationAdmission): void {
  if (facts.issuedAtMs < Date.now() - DEVICE_BOOTSTRAP_TOKEN_TTL_MS) {
    throw new DevicePairingAuthorityRefusedError();
  }
}

function resolveIssuedBootstrapProfileInput(params: {
  profile?: DeviceBootstrapProfileInput;
  roles?: readonly string[];
  scopes?: readonly string[];
}): DeviceBootstrapProfileInput | undefined {
  if (params.profile) {
    return params.profile;
  }
  if (params.roles || params.scopes) {
    return {
      roles: params.roles,
      scopes: params.scopes,
    };
  }
  return undefined;
}

function resolveIssuedBootstrapProfile(params: {
  profile?: DeviceBootstrapProfileInput;
  roles?: readonly string[];
  scopes?: readonly string[];
}): DeviceBootstrapProfile {
  const input = resolveIssuedBootstrapProfileInput(params);
  if (input) {
    // Issued tokens can request many roles/scopes, but bootstrap handoff persists only the allowlist.
    return normalizeDeviceBootstrapHandoffProfile(input);
  }
  // Generic bootstrap callers stay least-privilege. Official mobile setup
  // passes the full profile explicitly after validating the advertised URL.
  return PAIRING_SETUP_BOOTSTRAP_PROFILE;
}

function warnIfIssuedBootstrapScopesWereStripped(params: {
  input: DeviceBootstrapProfileInput | undefined;
  profile: DeviceBootstrapProfile;
}): void {
  if (!params.input) {
    return;
  }
  const requestedProfile = normalizeDeviceBootstrapProfile(params.input);
  const requestedScopes = requestedProfile.scopes;
  if (requestedScopes.length === 0) {
    return;
  }
  const retainedScopeSet = new Set(params.profile.scopes);
  const strippedScopes = requestedScopes.filter((scope) => !retainedScopeSet.has(scope));
  if (strippedScopes.length === 0) {
    return;
  }
  log.warn("bootstrap_token_scopes_stripped", {
    roles: requestedProfile.roles,
    requestedScopes,
    retainedScopes: params.profile.scopes,
    strippedScopes,
    consoleMessage: "bootstrap token scopes stripped to bootstrap handoff allowlist",
  });
}

type DeviceBootstrapTokenIssueParams = {
  /** Revalidate caller authority at the worker's transaction and commit boundaries. */
  assertCurrent?: () => void;
  baseDir?: string;
  profile?: DeviceBootstrapProfileInput;
  roles?: readonly string[];
  scopes?: readonly string[];
};

async function issueDeviceBootstrapTokenRecord(
  params: DeviceBootstrapTokenIssueParams & { setupId?: string },
): Promise<{ token: string; expiresAtMs: number }> {
  const assertCurrent = params.assertCurrent;
  return await withLock(async () => {
    const profile = resolveIssuedBootstrapProfile(params);
    warnIfIssuedBootstrapScopesWereStripped({
      input: resolveIssuedBootstrapProfileInput(params),
      profile,
    });
    return await executeDevicePairingMutation(
      { type: "bootstrap.issue", input: { profile, setupId: params.setupId, nowMs: Date.now() } },
      { baseDir: params.baseDir, assertCurrent },
    );
  });
}

/** Issue a short-lived generic bootstrap token with a bounded role/scope handoff profile. */
export async function issueDeviceBootstrapToken(
  params: DeviceBootstrapTokenIssueParams = {},
): Promise<{ token: string; expiresAtMs: number }> {
  return await issueDeviceBootstrapTokenRecord(params);
}

/**
 * Issue a setup bootstrap token plus an opaque correlation id. `setupId` is
 * minted here, beside the credential, so the presenting client can follow one
 * exact credential without ever handling the bearer token. Generic bootstrap
 * handoffs stay uncorrelated: only setup codes have a presenting client.
 */
export async function issueDevicePairSetupBootstrapToken(params: {
  baseDir?: string;
  profile: DeviceBootstrapProfileInput;
}): Promise<{ token: string; expiresAtMs: number; setupId: string }> {
  const setupId = randomUUID();
  const issued = await issueDeviceBootstrapTokenRecord({ ...params, setupId });
  return { ...issued, setupId };
}

type BootstrapParams<Key extends keyof DeviceBootstrapOperations> = Omit<
  DeviceBootstrapOperations[Key]["input"],
  "nowMs"
> & { baseDir?: string };

/** Reuse one environment-owned setup credential across provider replay. */
export async function ensureDevicePairSetupBootstrapToken(
  params: BootstrapParams<"bootstrap.ensure">,
): Promise<DeviceBootstrapOperations["bootstrap.ensure"]["output"]> {
  const { baseDir, ...input } = params;
  return await withLock(() =>
    executeDevicePairingMutation(
      { type: "bootstrap.ensure", input: { ...input, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

/** Consume only while the bound device and its live handoff authority remain current. */
export async function consumeDeviceBootstrapTokenWithSetupCompletion(
  params: BootstrapParams<"bootstrap.consume"> & {
    pairedDeviceMatches?: (device: PairedDevice | null) => boolean;
  },
): Promise<DeviceBootstrapOperations["bootstrap.consume"]["output"]> {
  const { baseDir, pairedDeviceMatches, ...input } = params;
  return await withLock(async () => {
    try {
      return await executeDevicePairingMutation(
        { type: "bootstrap.consume", input: { ...input, nowMs: Date.now() } },
        {
          baseDir,
          admit: (facts) => {
            if (facts.kind === "bootstrap.consume") {
              assertBootstrapTokenCurrent(facts);
              if (pairedDeviceMatches && !pairedDeviceMatches(facts.pairedDevice)) {
                throw new DevicePairingAuthorityRefusedError();
              }
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof DevicePairingAuthorityRefusedError) {
        return null;
      }
      throw error;
    }
  });
}

/** Confirm that the pairing client received the credential-bearing handoff response. */
export async function confirmDevicePairSetupCompletionDelivery(
  params: BootstrapParams<"bootstrap.confirm">,
): Promise<DeviceBootstrapOperations["bootstrap.confirm"]["output"]> {
  const { baseDir, ...input } = params;
  return await withLock(() =>
    executeDevicePairingMutation(
      { type: "bootstrap.confirm", input: { ...input, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

/** Read the terminal outcome and prune expired completions under the settlement lock. */
export async function readDevicePairSetupCompletion(
  params: BootstrapParams<"bootstrap.readCompletion">,
): Promise<DeviceBootstrapOperations["bootstrap.readCompletion"]["output"]> {
  const { baseDir, ...input } = params;
  return await withLock(() =>
    executeDevicePairingMutation(
      { type: "bootstrap.readCompletion", input: { ...input, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

/** Remove every outstanding bootstrap token. */
export async function clearDeviceBootstrapTokens(
  params: BootstrapParams<"bootstrap.clear"> & { assertCurrent?: () => void } = {},
): Promise<DeviceBootstrapOperations["bootstrap.clear"]["output"]> {
  const { baseDir, assertCurrent, ...input } = params;
  return await withLock(() =>
    executeDevicePairingMutation(
      { type: "bootstrap.clear", input: { ...input, nowMs: Date.now() } },
      { baseDir, assertCurrent },
    ),
  );
}

/** Revoke one bootstrap token and retain its record for best-effort restoration. */
export async function revokeDeviceBootstrapToken(
  params: BootstrapParams<"bootstrap.revoke">,
): Promise<DeviceBootstrapOperations["bootstrap.revoke"]["output"]> {
  const { baseDir, ...input } = params;
  return await withLock(() =>
    executeDevicePairingMutation(
      { type: "bootstrap.revoke", input: { ...input, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

/** Restore an uncorrelated bootstrap bearer after an undelivered credential response. */
export async function restoreGenericDeviceBootstrapToken(
  params: BootstrapParams<"bootstrap.restore">,
): Promise<DeviceBootstrapOperations["bootstrap.restore"]["output"]> {
  const { baseDir, ...input } = params;
  return await withLock(() =>
    executeDevicePairingMutation(
      { type: "bootstrap.restore", input: { ...input, nowMs: Date.now() } },
      { baseDir },
    ),
  );
}

/** Record one role/scope leg of a multi-role bootstrap handoff. */
export async function redeemDeviceBootstrapTokenProfile(
  params: BootstrapParams<"bootstrap.redeem">,
): Promise<DeviceBootstrapOperations["bootstrap.redeem"]["output"]> {
  const { baseDir, ...input } = params;
  return await withLock(async () => {
    try {
      return await executeDevicePairingMutation(
        { type: "bootstrap.redeem", input: { ...input, nowMs: Date.now() } },
        {
          baseDir,
          admit: (facts) => {
            if (facts.kind === "bootstrap.token") {
              assertBootstrapTokenCurrent(facts);
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof DevicePairingAuthorityRefusedError) {
        return { recorded: false, fullyRedeemed: false };
      }
      throw error;
    }
  });
}

/** Verify a bootstrap token, bind its first device identity, and stage requested scopes. */
export async function verifyDeviceBootstrapToken(
  params: BootstrapParams<"bootstrap.verify">,
): Promise<DeviceBootstrapOperations["bootstrap.verify"]["output"]> {
  const { baseDir, ...input } = params;
  return await withLock(async () => {
    try {
      return await executeDevicePairingMutation(
        { type: "bootstrap.verify", input: { ...input, nowMs: Date.now() } },
        {
          baseDir,
          admit: (facts) => {
            if (facts.kind === "bootstrap.token") {
              assertBootstrapTokenCurrent(facts);
            }
          },
        },
      );
    } catch (error) {
      if (error instanceof DevicePairingAuthorityRefusedError) {
        return { ok: false, reason: "bootstrap_token_invalid" };
      }
      throw error;
    }
  });
}

/** Remove retained setup outcomes independently of status requests or later pairings. */
export async function pruneExpiredDevicePairSetupCompletions(
  params: { nowMs?: number; baseDir?: string } = {},
): Promise<number> {
  return await withLock(() =>
    executeDevicePairingMutation(
      { type: "bootstrap.prune", input: { nowMs: params.nowMs ?? Date.now() } },
      { baseDir: params.baseDir },
    ),
  );
}

/** Read already-bound context only after verifying the same credential and identity. */
export async function getBoundDeviceBootstrapContext(params: {
  token: string;
  deviceId: string;
  publicKey: string;
  baseDir?: string;
}) {
  const { baseDir, ...input } = params;
  return await withLock(() =>
    loadBoundDeviceBootstrapContextReadOnly({ ...input, nowMs: Date.now() }, baseDir),
  );
}

/** Read the profile from already-bound bootstrap context. */
export async function getBoundDeviceBootstrapProfile(
  params: Parameters<typeof getBoundDeviceBootstrapContext>[0],
): Promise<DeviceBootstrapProfile | null> {
  return (await getBoundDeviceBootstrapContext(params))?.profile ?? null;
}
