import type { z } from "zod";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
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
import type { UpdateFailureFactSchema } from "./update-run-schema.js";
import { resolvePublicUpdateStepId } from "./update-step-identity.js";

type PublicFailureIdentifiers = Pick<
  z.infer<typeof UpdateFailureFactSchema>,
  "check" | "code" | "pluginId" | "errorName"
>;

// Fixed labels emitted by the canary, finalizer, package runner, and service verifier.
const CANARY_CHECKS = ["snapshot", "config", "plugins", "runtime", "startup", "readiness"] as const;
const NATIVE_CHECKS = new Set<string>([
  ...UPDATE_RUN_PHASES,
  ...CANARY_CHECKS,
  "doctor",
  "lint",
  "config-write",
  "preflight",
  "installation-inspection",
  "target-resolution",
  "git update",
  "update",
  "targetConfigValidation",
  "configSnapshot",
  "targetConfigConvergence",
  "completionCache",
  "readyz",
  "startupz",
  "versionMatch",
  "service",
  "pluginErrors",
  "channelsReady",
  "settled",
  "gateway-recovery",
  "node-runtime",
  "managed-service",
  "managed-service-preflight",
  "package-install",
  "package-swap",
  "package-runtime",
  "plugin-update",
  "plugin-sync",
  "plugin-convergence",
  "build",
  "openclaw doctor",
  "post-install verification",
  "package rollback",
  "global install verify",
  "global install swap",
  "npm lifecycle policy preflight",
]);

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
  "agent-database-lease-active",
  "global-install-failed",
  ...UPDATE_ENVIRONMENT_FAILURE_REASONS,
  "already-current",
  "container-image-install",
  "unmanaged-package-install",
  "package-update-requires-cli",
  "swap-failed",
  "verification-result-missing",
  "finalization-timeout",
  "finalization-failed",
  "no-output-timeout",
  "signal",
  "readyz-unhealthy",
  "service-not-running",
  "restart-unhealthy",
  "gateway-probe-failed",
  "restart-health-pending",
  "managed-service-preflight",
  "service-inspection-unavailable",
  "service-ownership-unverified",
  "database-schema-preflight",
  "update-ledger-busy",
  "invalid-git-directory",
  "managed-service-handoff-started",
  "managed-service-handoff-already-running",
  "managed-service-handoff-cancelled",
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
  "validation",
  "cron-owner-safety",
  "include-ownership",
  "config-conflict",
  "config-input-changed",
  "requester-revoked",
  "repair-requires-config-change",
]);

let publicPluginIds: Promise<ReadonlySet<string>> | undefined;
let publicDoctorCheckIds: Promise<ReadonlySet<string>> | undefined;

function loadPublicPluginIds(): Promise<ReadonlySet<string>> {
  publicPluginIds ??= Promise.all([
    import("../plugins/official-external-plugin-bundled-catalogs.js"),
    import("../plugins/official-external-plugin-catalog-source.js"),
  ]).then(([catalogs, identities]) => {
    // Installation directories can contain private extensions; only shipped catalogs establish public IDs.
    const ids = new Set<string>();
    for (const entry of catalogs.BUNDLED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_ENTRIES) {
      const id = identities.resolveOfficialExternalPluginId(entry);
      if (id) {
        ids.add(id);
      }
    }
    return ids;
  });
  return publicPluginIds;
}

function loadPublicDoctorCheckIds(): Promise<ReadonlySet<string>> {
  publicDoctorCheckIds ??= import("../flows/doctor-health-contributions.js")
    .then((doctor) => doctor.resolveDoctorContributionHealthChecks())
    .then((checks) => new Set(checks.map((check) => check.id)));
  return publicDoctorCheckIds;
}

/** Capture catalogs before an interactive update can replace their code. */
export async function preparePublicUpdateFailureIdentifiers(): Promise<void> {
  await Promise.allSettled([loadPublicDoctorCheckIds(), loadPublicPluginIds()]);
}

export function isPublicUpdateFailureCode(code: string): boolean {
  return (
    PUBLIC_CODES.has(code) ||
    isServiceInspectionReason(code) ||
    normalizeSupportDiagnosticErrorCode(code) !== undefined
  );
}

/** Only source-defined public identities leave the local diagnostic report. */
export async function projectPublicUpdateFailureIdentifiers(
  fact: PublicFailureIdentifiers,
): Promise<PublicFailureIdentifiers> {
  // Admission failures use their reason code as the check ID.
  const nativeCheck =
    NATIVE_CHECKS.has(fact.check) ||
    resolvePublicUpdateStepId(fact.check) === fact.check ||
    isPublicUpdateFailureCode(fact.check);
  // Unavailable metadata cannot establish that an identifier is public.
  const [doctorIds, pluginIds] = await Promise.all([
    nativeCheck ? undefined : loadPublicDoctorCheckIds().catch(() => undefined),
    fact.pluginId ? loadPublicPluginIds().catch(() => undefined) : undefined,
  ]);
  return {
    check: nativeCheck || doctorIds?.has(fact.check) ? fact.check : "[redacted-check]",
    code: isPublicUpdateFailureCode(fact.code)
      ? fact.code
      : fact.errorName
        ? isPublicUpdateFailureCode(fact.errorName)
          ? fact.errorName
          : "[redacted-error-class]"
        : "[redacted-code]",
    ...(fact.pluginId
      ? { pluginId: pluginIds?.has(fact.pluginId) ? fact.pluginId : "[redacted-plugin]" }
      : {}),
  };
}
