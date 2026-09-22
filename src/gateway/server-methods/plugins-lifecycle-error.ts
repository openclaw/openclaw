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
  OpenClawStateLeaseAcquisitionError,
  OpenClawStateLeaseError,
} from "../../state/openclaw-state-lease-error.js";

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

export function pluginLifecycleError(
  caught: unknown,
  {
    application,
    entered,
    signal,
  }: {
    application?: PluginRuntimeApplication;
    entered: boolean;
    signal?: AbortSignal;
  },
) {
  if (
    !entered &&
    caught instanceof OpenClawStateLeaseAcquisitionError &&
    caught.outcome.kind === "held"
  ) {
    return errorShape(
      ErrorCodes.UNAVAILABLE,
      "Another plugin or config operation is already running; retry when it completes.",
      { retryable: true, retryAfterMs: 1_000 },
    );
  }
  const error =
    caught instanceof OpenClawStateLeaseError &&
    caught.code === "OPENCLAW_STATE_LEASE_ABORTED" &&
    signal?.aborted &&
    caught.cause === signal.reason
      ? signal.reason
      : caught;
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
