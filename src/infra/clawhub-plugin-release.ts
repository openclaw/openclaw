import type {
  ClawHubDownloadability,
  ClawHubSelectedRelease,
} from "../../packages/gateway-protocol/src/schema/clawhub-listing.js";
import type { PluginInstallTrust } from "../../packages/gateway-protocol/src/schema/plugins.js";
import {
  readClawHubStringField,
  readClawHubStringArrayField,
  readRequiredClawHubStringField,
  readRequiredClawHubNumberField,
} from "./clawhub-client.js";
import {
  parseClawHubPackageSecurityResponse,
  type ClawHubPackageSecurityResponse,
} from "./clawhub-packages.js";
export type ClawHubPluginSecurity = {
  status: string;
  auditUrl?: string;
  verdict?: string;
  summary?: string;
  guidance?: string;
  checkedAt?: number;
};

function projectSecurity(value: ClawHubPackageSecurityResponse): ClawHubPluginSecurity {
  const trust = value.trust;
  const moderationStatus =
    trust.moderationState && trust.moderationState !== "approved"
      ? trust.moderationState
      : undefined;
  const status = trust.blockedFromDownload
    ? "blocked"
    : trust.pending
      ? "pending"
      : trust.stale
        ? "stale"
        : (moderationStatus ?? trust.scanStatus ?? "unknown");
  return {
    status,
    ...(value.verdict ? { verdict: value.verdict } : {}),
    auditUrl: value.securityAuditUrl,
    summary: value.overview,
  };
}

/** Project exact release facts; listing and artifact URLs cannot prove stored download bytes. */
export async function readClawHubPluginReleaseFacts(params: {
  value: Record<string, unknown>;
  versionRecord: Record<string, unknown> | undefined;
  packageName: string;
  version?: string;
}) {
  const { value, versionRecord } = params;
  const selectedRelease: ClawHubSelectedRelease | null = versionRecord
    ? {
        version: readRequiredClawHubStringField(
          versionRecord,
          "version",
          "selected plugin release",
        ),
        ...(versionRecord.createdAt != null
          ? {
              createdAt: readRequiredClawHubNumberField(
                versionRecord,
                "createdAt",
                "selected plugin release",
              ),
            }
          : {}),
        ...(versionRecord.changelog != null
          ? {
              changelog:
                readClawHubStringField(versionRecord, "changelog", "selected plugin release") ??
                undefined,
            }
          : {}),
        tags:
          readClawHubStringArrayField(versionRecord, "distTags", "selected plugin release") ?? [],
      }
    : null;
  if (params.version && selectedRelease?.version !== params.version) {
    throw new Error("ClawHub did not return the requested plugin release.");
  }
  const readme = readClawHubStringField(value, "readme", "plugin detail response");
  if (readme && Buffer.byteLength(readme, "utf8") > 512 * 1024) {
    throw new Error("ClawHub plugin README exceeded 524288 bytes.");
  }
  let security: ClawHubPluginSecurity | undefined;
  let trust: PluginInstallTrust | undefined;
  let downloadability: ClawHubDownloadability = selectedRelease
    ? {
        status: "unknown",
        reason: "ClawHub does not expose artifact storage availability for this release.",
      }
    : { status: "unavailable", reason: "The listing has no selected release." };
  if (value.security != null) {
    try {
      const parsedSecurity = parseClawHubPackageSecurityResponse(value.security);
      if (
        !selectedRelease ||
        (parsedSecurity.package?.name && parsedSecurity.package.name !== params.packageName) ||
        (parsedSecurity.release?.version &&
          parsedSecurity.release.version !== selectedRelease.version)
      ) {
        throw new Error("ClawHub security metadata does not describe the selected release.");
      }
      security = projectSecurity(parsedSecurity);
      const { assessClawHubTrust } = await import("./clawhub-install-trust.js");
      trust = {
        disposition: assessClawHubTrust(parsedSecurity.trust),
        reasons: parsedSecurity.trust.reasons,
        pending: parsedSecurity.trust.pending,
        stale: parsedSecurity.trust.stale,
      };
      if (parsedSecurity.trust.blockedFromDownload) {
        downloadability = {
          status: "unavailable",
          reason:
            parsedSecurity.trust.reasons.join("; ") || "ClawHub blocks downloads of this release.",
        };
      }
    } catch {
      // Security metadata is optional; malformed audit data must not hide the package.
    }
  }

  return { selectedRelease, readme, security, trust, downloadability };
}
