import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isDefaultClawHubBaseUrl } from "../infra/clawhub-client.js";
import type { ClawHubPackageDetail } from "../infra/clawhub-packages.js";

type ClawHubPackage = NonNullable<ClawHubPackageDetail["package"]>;

export function isTrustedSourceLinkedOfficialPackage(pkg: ClawHubPackage): boolean {
  const sourceRepo = normalizeOptionalString(pkg.verification?.sourceRepo);
  return (
    pkg.channel === "official" &&
    pkg.isOfficial &&
    pkg.verification?.tier === "source-linked" &&
    (sourceRepo === "openclaw/openclaw" ||
      sourceRepo === "github.com/openclaw/openclaw" ||
      sourceRepo === "https://github.com/openclaw/openclaw")
  );
}

export function isDefaultOfficialClawHubPackage(params: {
  baseUrl?: string;
  pkg: ClawHubPackage;
}): boolean {
  return (
    isDefaultClawHubBaseUrl(params.baseUrl) &&
    (params.pkg.channel === "official" || params.pkg.isOfficial)
  );
}
