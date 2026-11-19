// Read public Template catalog summaries; do not open or retain artifact file bodies.
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import { resolveClawHubImageUrl, type ClawHubFetchOptions } from "../infra/clawhub-client.js";
import {
  fetchClawHubTemplatesOverview,
  listClawHubPackages,
  searchClawHubPackages,
  type ClawHubPackageDetail,
  type ClawHubPackageListItem,
} from "../infra/clawhub-packages.js";
import type {
  ClawHubTemplateCatalogEntry,
  ClawHubTemplateCatalogOverview,
} from "./clawhub-catalog-types.js";
import { ClawHubSourceError } from "./clawhub-source-artifact.js";
import { clawHubTemplateRef, isCanonicalClawHubPackageName } from "./schema-portability.js";
const CATALOG_PAGE_SIZE = 20;

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

function projectPublicEntries(
  packages: unknown[],
  baseUrl?: string,
): ClawHubTemplateCatalogEntry[] {
  return packages.filter(isPublicTemplateListItem).map((pkg) => projectCatalogEntry(pkg, baseUrl));
}

function rankByInstalls(
  left: ClawHubTemplateCatalogEntry,
  right: ClawHubTemplateCatalogEntry,
): number {
  return right.installs - left.installs || left.packageName.localeCompare(right.packageName);
}

/** Only an unavailable endpoint or an explicitly incomplete overview uses legacy shelves. */
export async function readClawHubTemplatesOverview(
  params: ClawHubFetchOptions & { limit?: number } = {},
): Promise<ClawHubTemplateCatalogOverview | undefined> {
  const result = await fetchClawHubTemplatesOverview(params);
  if (isJsonObject(result) && result.complete === false) {
    return undefined;
  }
  if (
    !isJsonObject(result) ||
    result.complete !== true ||
    !Array.isArray(result.featured) ||
    !Array.isArray(result.sections) ||
    !result.sections.every(
      (section) =>
        isJsonObject(section) &&
        typeof section.category === "string" &&
        Array.isArray(section.items),
    )
  ) {
    throw new ClawHubSourceError(
      "clawhub_catalog_invalid",
      "ClawHub returned a malformed Template overview.",
    );
  }
  const limit = params.limit ?? 8;
  return {
    featured: projectPublicEntries(result.featured, params.baseUrl).slice(0, limit),
    sections: result.sections.map((section) => ({
      category: section.category,
      entries: projectPublicEntries(section.items, params.baseUrl)
        .toSorted(rankByInstalls)
        .slice(0, limit),
    })),
  };
}

type CatalogSearchParams = ClawHubFetchOptions & {
  query?: string;
  limit?: number;
  category?: string;
  featured?: boolean;
  cursor?: string;
};

const LEGACY_PAGE_SIZE = 100;
const MAX_LEGACY_CATEGORY_PAGES = 20;

// The deployed typed search returns a ranked prefix, not a registry cursor.
// These offsets page a freshly authorized projection, never a cached access decision.
function projectionPage(params: CatalogSearchParams, max: number) {
  const limit = params.limit ?? CATALOG_PAGE_SIZE;
  const prefix =
    "template-page:" +
    JSON.stringify([params.query?.trim() ?? "", params.category ?? "", limit]) +
    ":";
  const offset = !params.cursor ? 0 : Number(params.cursor.slice(prefix.length));
  if (
    params.cursor &&
    (params.cursor !== prefix + offset ||
      !Number.isInteger(offset) ||
      offset <= 0 ||
      offset >= max ||
      offset % limit !== 0)
  ) {
    throw new ClawHubSourceError(
      "clawhub_catalog_cursor_invalid",
      "Invalid Template page cursor. Start a new search.",
    );
  }
  return {
    offset,
    limit,
    project(entries: ClawHubTemplateCatalogEntry[]) {
      const end = offset + limit;
      return {
        entries: entries.slice(offset, end),
        ...(entries.length > end ? { nextCursor: prefix + end } : {}),
      };
    },
  };
}

async function listPublicPage(params: CatalogSearchParams) {
  const limit = params.limit ?? CATALOG_PAGE_SIZE;
  const ranked =
    params.category && !params.featured
      ? projectionPage(params, LEGACY_PAGE_SIZE * MAX_LEGACY_CATEGORY_PAGES)
      : undefined;
  const entries = new Map<string, ClawHubTemplateCatalogEntry>();
  let cursor = ranked ? undefined : params.cursor;
  const seen = new Set(cursor ? [cursor] : []);
  // The old registry orders categories by update time, not installs. Only a
  // complete category reproduces its global ranking. Other feeds stop as soon
  // as the visible page fills, continuing past ineligible rows when necessary.
  for (let n = 0; n < MAX_LEGACY_CATEGORY_PAGES; n++) {
    const { items, nextCursor } = await listClawHubPackages({
      ...params,
      family: "template",
      limit: ranked ? LEGACY_PAGE_SIZE : limit - entries.size,
      cursor,
    });
    for (const entry of projectPublicEntries(items, params.baseUrl)) {
      entries.set(entry.packageName, entry);
    }
    if (nextCursor !== null && (!nextCursor || seen.has(nextCursor))) {
      throw new ClawHubSourceError(
        "clawhub_catalog_cursor_invalid",
        "ClawHub returned a repeating catalog cursor.",
      );
    }
    if (nextCursor === null || (!ranked && entries.size >= limit)) {
      const result = [...entries.values()];
      return ranked
        ? ranked.project(result.toSorted(rankByInstalls))
        : { entries: result.slice(0, limit), nextCursor };
    }
    cursor = nextCursor;
    seen.add(cursor);
  }
  throw new ClawHubSourceError(
    "clawhub_catalog_too_large",
    "ClawHub returned too many catalog pages for this request.",
  );
}

export async function searchClawHubTemplates(
  params: CatalogSearchParams = {},
): Promise<{ entries: ClawHubTemplateCatalogEntry[]; nextCursor?: string | null }> {
  const query = params.query?.trim();
  if (!query) {
    return await listPublicPage(params);
  }
  const page = projectionPage(params, LEGACY_PAGE_SIZE);
  // The deployed search API has no cursor. Its candidate set (and thus its
  // ranking) depends on the limit. Page a fixed window: asking for 20, then 40,
  // can skip a newly higher-ranked result and repeat the one it displaced.
  const results = await searchClawHubPackages({
    ...params,
    family: "template",
    query,
    limit: LEGACY_PAGE_SIZE,
  });
  const entries = projectPublicEntries(
    results.map((result) => result.package),
    params.baseUrl,
  );
  return page.project(params.category ? entries.toSorted(rankByInstalls) : entries);
}
