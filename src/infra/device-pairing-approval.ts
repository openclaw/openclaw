// Pairing approval keeps host policy live until the worker commits its authoritative rows.
import type { DeviceBootstrapProfile } from "../shared/device-bootstrap-profile.js";
import type {
  ApproveDevicePairingResult,
  DeviceBootstrapApprovalOptions,
  DevicePairingApprovalOptions,
  DevicePairingForbiddenResult,
} from "./device-pairing-core.types.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { resolvePairingRequestExpiry } from "./device-pairing-state.kernel.js";
import type { DevicePairingAdmissionFacts } from "./device-pairing-worker-contract.js";
import {
  DevicePairingAuthorityRefusedError,
  executeDevicePairingMutation,
} from "./device-pairing-worker.js";

/** Format a device-pairing authorization failure for CLI/API callers. */
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
  return await withDevicePairingLock(async () => {
    const admission = approvalAdmission(options);
    try {
      return await executeDevicePairingMutation(
        {
          type: "devicePairing.approve",
          input: { requestId, options: wireOptions, nowMs: Date.now() },
        },
        {
          baseDir,
          admit: admission.admit,
        },
      );
    } catch (error) {
      if (error instanceof DevicePairingAuthorityRefusedError) {
        return admission.refusedResult;
      }
      throw error;
    }
  });
}

export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  options: DeviceBootstrapApprovalOptions,
  baseDir?: string,
): Promise<ApproveDevicePairingResult>;
export async function approveBootstrapDevicePairing(
  requestId: string,
  bootstrapProfile: DeviceBootstrapProfile,
  optionsOrBaseDir?: DeviceBootstrapApprovalOptions | string,
  maybeBaseDir?: string,
): Promise<ApproveDevicePairingResult> {
  const options = typeof optionsOrBaseDir === "object" ? optionsOrBaseDir : undefined;
  const baseDir = typeof optionsOrBaseDir === "string" ? optionsOrBaseDir : maybeBaseDir;
  return await withDevicePairingLock(async () => {
    const admission = approvalAdmission(options);
    try {
      const { result } = await executeDevicePairingMutation(
        {
          type: "devicePairing.approveBootstrap",
          input: {
            requestId,
            bootstrapProfile,
            accessMetadata: options?.accessMetadata,
            nowMs: Date.now(),
          },
        },
        {
          baseDir,
          onTokensReplaced: options?.onTokensReplaced,
          admit: admission.admit,
        },
      );
      return result;
    } catch (error) {
      if (error instanceof DevicePairingAuthorityRefusedError) {
        return admission.refusedResult;
      }
      throw error;
    }
  });
}
