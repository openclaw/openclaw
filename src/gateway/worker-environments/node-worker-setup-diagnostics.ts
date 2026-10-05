// Fixed setup marker projection; command outcome and logging stay with the workspace owner.
import { isRecord } from "@openclaw/normalization-core/record-coerce";

// Contract emitted by the worker feed helper, not an arbitrary stderr/error envelope.
const managedIdentityCodes = new Set([
  "http_rejected",
  "response_too_large",
  "response_error",
  "response_parse_error",
  "audience_mismatch",
  "token_missing",
  "token_whitespace",
  "expiry_invalid",
  "expiry_rejected",
  "transport_error",
  "timeout",
  "unclassified",
]);
const imdsErrorCodes = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_resource",
  "unauthorized_client",
  "access_denied",
  "temporarily_unavailable",
  "server_error",
  "unclassified",
]);
const imdsErrorCategories = new Set(["identity_not_found", "multiple_identities", "unclassified"]);

type ManagedIdentityDiagnostic = {
  diagnosticCode: string;
  httpStatus: number | null;
  imdsErrorCode?: string;
  imdsErrorCategory?: string;
};

function managedIdentityDiagnostic(line: string): ManagedIdentityDiagnostic | undefined {
  if (!line.startsWith("{") || line.length > 2048) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.event !== "worker_feed_managed_identity" ||
    typeof value.code !== "string" ||
    !managedIdentityCodes.has(value.code) ||
    !(
      value.httpStatus === null ||
      (typeof value.httpStatus === "number" &&
        Number.isInteger(value.httpStatus) &&
        value.httpStatus >= 100 &&
        value.httpStatus <= 599)
    )
  ) {
    return undefined;
  }
  return {
    diagnosticCode: value.code,
    httpStatus: value.httpStatus,
    ...(value.code === "http_rejected"
      ? {
          imdsErrorCode:
            typeof value.imdsErrorCode === "string" && imdsErrorCodes.has(value.imdsErrorCode)
              ? value.imdsErrorCode
              : "unclassified",
          imdsErrorCategory:
            typeof value.imdsErrorCategory === "string" &&
            imdsErrorCategories.has(value.imdsErrorCategory)
              ? value.imdsErrorCategory
              : "unclassified",
        }
      : {}),
  };
}
const setupStages = new Set([
  "repository_channel",
  "env_load",
  "credential_acquisition",
  "credential_transport",
  "msrustup_probe",
  "msrustup_install",
  "toolchain_probe",
  "toolchain_install",
  "provenance",
  "compiler_probe",
  "formatter_probe",
  "clippy_probe",
]);

export function summarizeWorkerSetupMarkers(stderr: string) {
  const markers: {
    helperStage: string;
    helperOutcome: string;
    helperExitCode?: number;
    helperElapsedMs?: number;
  }[] = [];
  let helperMarkerCount = 0;
  let workerFeedManagedIdentity: ManagedIdentityDiagnostic | undefined;
  for (const line of stderr.split(/\r?\n/u).slice(0, -1)) {
    workerFeedManagedIdentity = managedIdentityDiagnostic(line) ?? workerFeedManagedIdentity;
    const marker =
      /^TEAMCLAW_SETUP_V1 stage=([a-z_]+) outcome=(started|succeeded|failed)(?: exit=(0|[1-9][0-9]{0,2}))?(?: elapsedMs=(0|[1-9][0-9]{0,9}))?$/u.exec(
        line,
      );
    if (
      !marker ||
      !setupStages.has(marker[1]!) ||
      (marker[3] !== undefined && (marker[2] !== "failed" || Number(marker[3]) > 255)) ||
      (marker[4] !== undefined && Number(marker[4]) > 2_147_483_647)
    ) {
      continue;
    }
    helperMarkerCount += 1;
    markers.push({
      helperStage: marker[1]!,
      helperOutcome: marker[2]!,
      helperExitCode: marker[3] === undefined ? undefined : Number(marker[3]),
      ...(marker[4] === undefined ? {} : { helperElapsedMs: Number(marker[4]) }),
    });
    // Retain a bounded sequence, not arbitrary script output or an overlapping duration sum.
    if (markers.length > 24) {
      markers.shift();
    }
  }
  return {
    ...markers.at(-1),
    helperMarkerCount,
    helperMarkers: markers,
    ...(workerFeedManagedIdentity ? { workerFeedManagedIdentity } : {}),
  };
}
