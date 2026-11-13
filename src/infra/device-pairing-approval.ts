import {
  deviceBootstrapProfilesEqual,
  normalizeDeviceBootstrapHandoffProfile,
  type DeviceBootstrapProfile,
} from "../shared/device-bootstrap-profile.js";
// Pairing approval keeps host policy live until the worker commits its authoritative rows.
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { prepareUserProfileSelectionAuthority } from "../state/user-channel-identity-operations.js";
import { prepareDeviceBootstrapProfileAuthority } from "./device-bootstrap-profile-authority.js";
import type { DevicePairingAdmissionFacts } from "./device-pairing-admission.types.js";
import type {
  ApproveDevicePairingResult,
  DeviceBootstrapApprovalOptions,
  DevicePairingApprovalOptions,
  DevicePairingForbiddenResult,
} from "./device-pairing-core.types.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { publishDevicePairingResolution } from "./device-pairing-resolution.js";
import { resolvePairingRequestExpiry } from "./device-pairing-state.kernel.js";
import {
  loadPairedDevicePairingStoreRecordReadOnly,
  loadPendingDevicePairingStoreRecordReadOnly,
} from "./device-pairing-store-readonly.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "./device-pairing-worker.js";

export function formatDevicePairingForbiddenMessage(result: DevicePairingForbiddenResult): string {
  switch (result.reason) {
    case "caller-scopes-required":
      return `missing scope: ${result.scope ?? "callerScopes-required"}`;
    case "caller-missing-scope":
      return `missing scope: ${result.scope ?? "unknown"}`;
    case "scope-outside-requested-roles":
      return `invalid scope for requested roles: ${result.scope ?? "unknown"}`;
    case "approval-policy-changed":
      return "automatic pairing policy changed; retry pairing or request manual approval";
    case "bootstrap-role-not-allowed":
      return `bootstrap profile does not allow role: ${result.role ?? "unknown"}`;
    case "bootstrap-scope-not-allowed":
      return `bootstrap profile does not allow scope: ${result.scope ?? "unknown"}`;
  }
  throw new Error("Unsupported device pairing forbidden reason");
}

function approvalAdmission(
  options: Pick<DevicePairingApprovalOptions, "isApprovalCurrent"> | undefined,
) {
  let expired = false;
  return {
    get refusedResult(): ApproveDevicePairingResult {
      return expired ? null : { status: "forbidden", reason: "approval-policy-changed" };
    },
    admit: (facts: DevicePairingAdmissionFacts) => {
      if (facts.kind !== "pairing-approval") {
        return;
      }
      if (
        Date.now() > resolvePairingRequestExpiry(facts.pending.refreshedAtMs ?? facts.pending.ts)
      ) {
        expired = true;
        throw new DevicePairingAuthorityRefusedError(
          "Pairing request expired before approval commit",
        );
      }
      if (
        options?.isApprovalCurrent?.({ pending: facts.pending, existing: facts.existing }) === false
      ) {
        throw new DevicePairingAuthorityRefusedError("Pairing approval policy changed");
      }
    },
  };
}

function publishApproval(requestId: string, result: ApproveDevicePairingResult, baseDir?: string) {
  if (result?.status === "approved") {
    publishDevicePairingResolution(
      { requestId, deviceId: result.device.deviceId },
      "approved",
      baseDir,
    );
  }
  return result;
}

export async function approveDevicePairing(
  requestId: string,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  options: DevicePairingApprovalOptions,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveDevicePairing(
  requestId: string,
  optionsOrBaseDir?: DevicePairingApprovalOptions | string,
  maybeBaseDir?: string,
): Promise<ApproveDevicePairingResult> {
  const options = typeof optionsOrBaseDir === "object" ? optionsOrBaseDir : undefined;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  const { isApprovalCurrent: _isApprovalCurrent, ...wireOptions } = options ?? {};
  const profileId = options?.operatorProfileId;
  const context =
    profileId !== undefined
      ? captureOpenClawStateWorkerContext(
          baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {},
        )
      : undefined;
  const person =
    context && profileId !== undefined
      ? await prepareUserProfileSelectionAuthority(profileId, {
          path: context.admission.databasePath,
          env: context.environment,
        })
      : undefined;
  const assertProfile = context
    ? () => {
        context.admission.assertCurrent();
        if (!person?.isCurrent() || person.profileId !== profileId) {
          throw new Error("Pairing requires a current personal profile");
        }
      }
    : undefined;
  assertProfile?.();
  return await withDevicePairingLock(async () => {
    const admission = approvalAdmission(options);
    const result = await executeDevicePairingMutation(
      {
        type: "devicePairing.approve",
        input: { requestId, options: wireOptions, nowMs: Date.now() },
      },
      {
        baseDir,
        context,
        assertCurrent: assertProfile,
        onAuthorityRefused: () => admission.refusedResult,
        admit: admission.admit,
      },
    );
    return publishApproval(requestId, result, baseDir);
  }, "devicePairing.approve");
}

export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  options: DeviceBootstrapApprovalOptions = {},
  baseDir?: string,
): Promise<ApproveDevicePairingResult> {
  return await withDevicePairingLock(async () => {
    const pending = await loadPendingDevicePairingStoreRecordReadOnly(requestId, baseDir);
    const existing = pending
      ? await loadPairedDevicePairingStoreRecordReadOnly(pending.deviceId, baseDir)
      : null;
    const inheritedPerson =
      bootstrapProfile.roles.includes("operator") && existing?.publicKey === pending?.publicKey
        ? existing?.operatorProfileId
        : undefined;
    const requestedProfile = normalizeDeviceBootstrapHandoffProfile({
      ...bootstrapProfile,
      ...(bootstrapProfile.operatorProfileId === undefined && inheritedPerson
        ? { operatorProfileId: inheritedPerson }
        : {}),
    });
    const authority = await prepareDeviceBootstrapProfileAuthority(requestedProfile, { baseDir });
    if (!deviceBootstrapProfilesEqual(requestedProfile, authority.profile)) {
      throw new Error("Bootstrap person role no longer permits the issued grant");
    }
    const admission = approvalAdmission(options);
    const { result } = await executeDevicePairingMutation(
      {
        type: "devicePairing.approveBootstrap",
        input: {
          requestId,
          bootstrapProfile: authority.profile,
          bootstrapSource: options.bootstrapSource,
          accessMetadata: options?.accessMetadata,
          nowMs: Date.now(),
        },
      },
      {
        context: authority.context,
        assertCurrent: authority.assertCurrent,
        onTokensReplaced: options?.onTokensReplaced,
        onAuthorityRefused: () => ({ result: admission.refusedResult, replacedRoles: [] }),
        admit: (facts) => {
          admission.admit(facts);
          if (facts.kind === "bootstrap.token" && facts.expiresAtMs < Date.now()) {
            throw new DevicePairingAuthorityRefusedError(
              "Bootstrap source expired before approval",
            );
          }
        },
      },
    );
    return publishApproval(requestId, result, baseDir);
  }, "devicePairing.approveBootstrap");
}
