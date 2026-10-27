import { isDefaultClawHubBaseUrl } from "../infra/clawhub-client.js";
import type { ClawHubPackageDetail } from "../infra/clawhub-packages.js";

type ClawHubPackage = NonNullable<ClawHubPackageDetail["package"]>;

export function isDefaultOfficialClawHubPackage(params: {
  baseUrl?: string;
  pkg: ClawHubPackage;
}): boolean {
  return (
    isDefaultClawHubBaseUrl(params.baseUrl) &&
    (params.pkg.channel === "official" || params.pkg.isOfficial)
  );
}
