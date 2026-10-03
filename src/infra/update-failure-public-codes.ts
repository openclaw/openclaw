import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { GATEWAY_RESTART_WAIT_OUTCOMES } from "../cli/daemon-cli/restart-health.types.js";
import { isServiceInspectionReason } from "../daemon/service-inspection-error.js";
import { normalizeSupportDiagnosticErrorCode } from "../logging/diagnostic-support-redaction.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub-error-codes.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install-types.js";
import {
  SKIPPED_UPDATE_OUTCOMES,
  UPDATE_ENVIRONMENT_FAILURE_REASONS,
} from "../shared/update-outcome.js";
import { UPDATE_PREFLIGHT_DETAILS } from "./update-preflight-details.js";
import { updateRecoverySchema } from "./update-recovery.js";

export const CANARY_CHECKS = [
  "snapshot",
  "config",
  "plugins",
  "runtime",
  "startup",
  "readiness",
] as const;

const PUBLIC_CODES = new Set<string>([
  ...Object.keys(UPDATE_PREFLIGHT_DETAILS),
  ...Object.keys(SKIPPED_UPDATE_OUTCOMES),
  ...Object.values(PLUGIN_INSTALL_ERROR_CODE),
  ...Object.values(CLAWHUB_INSTALL_ERROR_CODE),
  PLUGIN_CAPABILITY_CONSENT_REQUIRED,
  ...updateRecoverySchema.options[1].shape.reason.options,
  ...GATEWAY_RESTART_WAIT_OUTCOMES,
  ...CANARY_CHECKS.map((phase) => `candidate-${phase}-failed`),
  "candidate-readiness-probe-failed",
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "ERR_SQLITE_ERROR",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_READONLY",
  "SQLITE_IOERR",
  "SQLITE_FULL",
  "command-failed",
  "doctor-failed",
  "doctor-processes-unsettled",
  "agent-database-lease-active",
  "global-install-failed",
  "unexpected-error",
  "invalid-update-target",
  "unsupported-update-target",
  "update-target-upstream-mismatch",
  "update-target-campaign-mismatch",
  "update-campaign-applying",
  "not-openclaw-root",
  "restart-disabled",
  "restart-unavailable",
  ...UPDATE_ENVIRONMENT_FAILURE_REASONS,
  "swap-failed",
  "package-integrity-changed",
  "baseline-scan-failed",
  "verification-result-missing",
  "finalization-timeout",
  "finalization-failed",
  "no-output-timeout",
  "signal",
  "readyz-unhealthy",
  "service-not-running",
  "restart-unhealthy",
  "gateway-probe-failed",
  "managed-service-preflight",
  "service-inspection-unavailable",
  "service-ownership-unverified",
  "database-schema-preflight",
  "invalid-git-directory",
  "managed-service-handoff-failed",
  "managed-service-stop-failed",
  "rollback-state-unverified",
  "target-metadata-preflight",
  "target-native-unsupported",
  "target-state-initialization",
  "source-exposure-preparation-failed",
  "plugin-update-failed",
  "plugin-sync-failed",
  "post-update-plugins",
  "post-plugin-doctor-execution-failed",
  "post-plugin-doctor-invalid-config",
  "post-plugin-config-validation-execution-failed",
  "post-plugin-update-readiness-execution-failed",
  "post-plugin-update-readiness-failed",
  "invalid-config",
  "config-read-failed",
  "validation",
  "cron-owner-safety",
  "include-ownership",
  "config-conflict",
  "config-input-changed",
  "requester-revoked",
  "repair-requires-config-change",
]);

export function isPublicUpdateFailureCode(code: string): boolean {
  return (
    PUBLIC_CODES.has(code) ||
    isServiceInspectionReason(code) ||
    normalizeSupportDiagnosticErrorCode(code) !== undefined
  );
}
