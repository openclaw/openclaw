import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { GATEWAY_RESTART_WAIT_OUTCOMES } from "../cli/daemon-cli/restart-health.types.js";
import { isServiceInspectionReason } from "../daemon/service-inspection-error.js";
import { normalizeSupportDiagnosticErrorCode } from "../logging/diagnostic-support-redaction.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "../plugins/clawhub-error-codes.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install-types.js";
import type { UpdateFailureFact } from "./update-failure-facts.js";
import { updateRecoverySchema } from "./update-recovery.js";

type PublicFailureIdentifiers = Pick<UpdateFailureFact, "check" | "code" | "pluginId">;

// Fixed labels emitted by the canary, finalizer, package runner, and service verifier.
const CANARY_CHECKS = ["snapshot", "config", "plugins", "runtime", "startup", "readiness"] as const;
const NATIVE_CHECKS = new Set<string>([
  ...UPDATE_RUN_PHASES,
  ...CANARY_CHECKS,
  "doctor",
  "lint",
  "config-write",
  "preflight",
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
  ...Object.values(PLUGIN_INSTALL_ERROR_CODE),
  ...Object.values(CLAWHUB_INSTALL_ERROR_CODE),
  PLUGIN_CAPABILITY_CONSENT_REQUIRED,
  ...updateRecoverySchema.options[1].shape.reason.options,
  ...GATEWAY_RESTART_WAIT_OUTCOMES,
  ...CANARY_CHECKS.map((phase) => `candidate-${phase}-failed`),
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "command-failed",
  "doctor-failed",
  "global-install-failed",
  "swap-failed",
  "verification-result-missing",
  "finalization-timeout",
  "finalization-failed",
  "no-output-timeout",
  "signal",
  "readyz-unhealthy",
  "service-not-running",
  "restart-unhealthy",
  "managed-service-preflight",
  "service-inspection-unavailable",
  "service-ownership-unverified",
  "node-runtime-preflight",
  "database-schema-preflight",
  "invalid-git-directory",
  "managed-service-handoff-already-running",
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

function isPublicCode(code: string): boolean {
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
  const nativeCheck = NATIVE_CHECKS.has(fact.check) || isPublicCode(fact.check);
  // Unavailable metadata cannot establish that an identifier is public.
  const [doctorIds, pluginIds] = await Promise.all([
    nativeCheck ? undefined : loadPublicDoctorCheckIds().catch(() => undefined),
    fact.pluginId ? loadPublicPluginIds().catch(() => undefined) : undefined,
  ]);
  return {
    check: nativeCheck || doctorIds?.has(fact.check) ? fact.check : "[redacted-check]",
    code: isPublicCode(fact.code) ? fact.code : "[redacted-code]",
    ...(fact.pluginId
      ? { pluginId: pluginIds?.has(fact.pluginId) ? fact.pluginId : "[redacted-plugin]" }
      : {}),
  };
}
