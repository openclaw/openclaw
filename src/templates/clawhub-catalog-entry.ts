import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { resolveClawHubImageUrl } from "../infra/clawhub-client.js";
import type { ClawHubPackageDetail, ClawHubPackageListItem } from "../infra/clawhub-packages.js";
import type { ClawHubTemplateCatalogEntry } from "./clawhub-catalog-types.js";
import { ClawHubSourceError } from "./clawhub-source-artifact.js";
import { clawHubTemplateRef, isCanonicalClawHubPackageName } from "./schema-portability.js";

type PublicTemplatePackage = ClawHubPackageListItem & { channel: "official" | "community" };
type OwnedTemplatePackage = PublicTemplatePackage & { ownerHandle: string };

function isPublicTemplatePackage(pkg: unknown): pkg is PublicTemplatePackage {
  return (
    isJsonObject(pkg) &&
    typeof pkg.name === "string" &&
    typeof pkg.displayName === "string" &&
    typeof pkg.updatedAt === "number" &&
    Number.isFinite(pkg.updatedAt) &&
    (pkg.summary === undefined || pkg.summary === null || typeof pkg.summary === "string") &&
    (pkg.latestVersion === undefined ||
      pkg.latestVersion === null ||
      typeof pkg.latestVersion === "string") &&
    pkg.family === "template" &&
    ((pkg.channel === "official" && pkg.isOfficial === true) ||
      (pkg.channel === "community" && pkg.isOfficial === false)) &&
    isCanonicalClawHubPackageName(pkg.name)
  );
}

function matchesTemplatePublisher(name: string, ownerHandle: unknown): ownerHandle is string {
  return (
    typeof ownerHandle === "string" &&
    ownerHandle.length > 0 &&
    (!name.startsWith("@") || name.slice(1, name.indexOf("/")) === ownerHandle)
  );
}

function isPublicTemplateListItem(pkg: unknown): pkg is OwnedTemplatePackage {
  return isPublicTemplatePackage(pkg) && matchesTemplatePublisher(pkg.name, pkg.ownerHandle);
}

export function requirePublicTemplatePackage(
  detail: ClawHubPackageDetail,
  requestedName: string,
): OwnedTemplatePackage {
  const pkg = detail.package;
  const ownerHandle = detail.owner?.handle;
  if (
    !isPublicTemplatePackage(pkg) ||
    !matchesTemplatePublisher(pkg.name, ownerHandle) ||
    (pkg.name !== requestedName && clawHubTemplateRef(pkg.name, ownerHandle) !== requestedName) ||
    (pkg.ownerHandle !== undefined && pkg.ownerHandle !== null && pkg.ownerHandle !== ownerHandle)
  ) {
    throw new ClawHubSourceError(
      "clawhub_identity_mismatch",
      "ClawHub returned a different public Template package identity.",
    );
  }
  return { ...pkg, ownerHandle, ownerOfficial: detail.owner?.official === true };
}

export function projectCatalogEntry(
  pkg: OwnedTemplatePackage,
  baseUrl?: string,
): ClawHubTemplateCatalogEntry {
  const iconUrl = resolveClawHubImageUrl(
    typeof pkg.icon === "string" ? pkg.icon : undefined,
    baseUrl,
  );
  const downloads = pkg.stats?.downloads;
  const installs = pkg.stats?.installs;
  return {
    packageName: pkg.name,
    ...(iconUrl ? { iconUrl } : {}),
    displayName: pkg.displayName,
    ...(pkg.summary ? { summary: pkg.summary } : {}),
    ...(pkg.latestVersion ? { latestVersion: pkg.latestVersion } : {}),
    channel: pkg.channel,
    official: pkg.ownerOfficial === true,
    ownerHandle: pkg.ownerHandle,
    downloads:
      typeof downloads === "number" && Number.isFinite(downloads) ? Math.max(0, downloads) : 0,
    installs: typeof installs === "number" && Number.isFinite(installs) ? Math.max(0, installs) : 0,
    ...(typeof pkg.featuredAt === "number" ? { featuredAt: pkg.featuredAt } : {}),
    updatedAtMs: Math.max(0, pkg.updatedAt),
  };
}

export function projectPublicEntries(
  packages: unknown[],
  baseUrl?: string,
): ClawHubTemplateCatalogEntry[] {
  return packages.filter(isPublicTemplateListItem).map((pkg) => projectCatalogEntry(pkg, baseUrl));
}

export function rankByInstalls(
  left: ClawHubTemplateCatalogEntry,
  right: ClawHubTemplateCatalogEntry,
): number {
  return right.installs - left.installs || left.packageName.localeCompare(right.packageName);
}
