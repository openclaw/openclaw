import { buildCapabilityConsentErrorDetails } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import {
  buildClawHubTrustErrorDetails,
  ErrorCodes,
  errorShape,
  isClawHubTrustErrorCode,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
  readInstallPolicyWarningErrorDetails,
} from "../../../packages/gateway-protocol/src/install-policy-warning-error-details.js";
import {
  capturePluginRuntimeApplications,
  PluginInstallPersistedError,
  projectPluginRuntimeFailure,
  type PluginLifecycleRuntimeApply,
  type PluginRuntimeApplication,
} from "../../plugins/lifecycle.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import {
  withPluginLifecycleLease,
  type PluginLifecycleLeaseContext,
} from "../../plugins/plugin-lifecycle-lease.js";
import { OpenClawStateLeaseError } from "../../state/openclaw-state-lease.js";

export function captureGatewayPluginRuntimeApplications(
  applyRuntime: PluginLifecycleRuntimeApply,
  assertCurrent: () => void,
) {
  assertCurrent();
  return capturePluginRuntimeApplications((change) => {
    assertCurrent();
    return applyRuntime({
      ...change,
      assertInvokerOwned: () => {
        assertCurrent();
        change.assertInvokerOwned?.();
      },
    });
  });
}

class GatewayPluginLifecycleBusyError extends Error {
  constructor(cause: OpenClawStateLeaseError) {
    super("Another plugin or config operation is already running; retry when it completes.", {
      cause,
    });
    this.name = "GatewayPluginLifecycleBusyError";
  }
}

export async function withGatewayPluginLifecycleLease<T>(
  signal: AbortSignal | undefined,
  run: (lease: PluginLifecycleLeaseContext) => Promise<T>,
): Promise<T> {
  let entered = false;
  try {
    // An admitted RPC cannot wait on a config reload that is draining that RPC.
    return await withPluginLifecycleLease({ signal, waitMs: 0 }, (lease) => {
      entered = true;
      return run(lease);
    });
  } catch (error) {
    if (
      !entered &&
      error instanceof OpenClawStateLeaseError &&
      error.code === "OPENCLAW_STATE_LEASE_TIMEOUT"
    ) {
      throw new GatewayPluginLifecycleBusyError(error);
    }
    if (
      error instanceof OpenClawStateLeaseError &&
      error.code === "OPENCLAW_STATE_LEASE_ABORTED" &&
      signal?.aborted &&
      error.cause === signal.reason
    ) {
      throw signal.reason;
    }
    throw error;
  }
}

export function pluginLifecycleError(error: unknown, application?: PluginRuntimeApplication) {
  if (error instanceof GatewayPluginLifecycleBusyError) {
    return errorShape(ErrorCodes.UNAVAILABLE, error.message, {
      retryable: true,
      retryAfterMs: 1_000,
    });
  }
  const failure = projectPluginRuntimeFailure(error, application);
  const cause = error instanceof PluginInstallPersistedError ? error.cause : error;
  const lifecycleError = cause instanceof ManagedPluginLifecycleError ? cause : undefined;
  const installDetails = lifecycleError?.capabilityConsent
    ? buildCapabilityConsentErrorDetails(lifecycleError.capabilityConsent)
    : lifecycleError?.installPolicyWarning
      ? readInstallPolicyWarningErrorDetails({
          installPolicyCode: INSTALL_POLICY_WARNING_ACKNOWLEDGEMENT_REQUIRED,
          ...lifecycleError.installPolicyWarning,
        })
      : lifecycleError
        ? buildClawHubTrustErrorDetails({
            code: isClawHubTrustErrorCode(lifecycleError.code) ? lifecycleError.code : undefined,
            version: lifecycleError.version,
            warning: lifecycleError.warning,
          })
        : undefined;
  const refusal =
    !failure.persistence && lifecycleError?.installRejected
      ? {
          pluginInstallRejected: true,
          ...(lifecycleError.code ? { pluginInstallCode: lifecycleError.code } : {}),
          ...(lifecycleError.installSource
            ? { pluginInstallSource: lifecycleError.installSource }
            : {}),
        }
      : undefined;
  const details =
    failure.runtime || failure.persistence || refusal
      ? {
          ...installDetails,
          ...refusal,
          ...(failure.runtime ? { runtime: failure.runtime } : {}),
          ...(failure.persistence ? { persistence: failure.persistence } : {}),
          ...(failure.runtimeAttempt ? { runtimeAttempt: failure.runtimeAttempt } : {}),
        }
      : installDetails;
  return errorShape(
    lifecycleError?.kind === "invalid-request"
      ? ErrorCodes.INVALID_REQUEST
      : ErrorCodes.UNAVAILABLE,
    failure.message,
    details ? { details } : undefined,
  );
}
