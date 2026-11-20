// Read public Template catalog summaries; do not open or retain artifact file bodies.
import { isRecord as isJsonObject } from "@openclaw/normalization-core/record-coerce";
import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import {
  fetchClawHubTemplatesOverview,
  listClawHubPackages,
  searchClawHubPackages,
  type ClawHubTemplatesOverviewOptions,
} from "../infra/clawhub-packages.js";
import { projectPublicEntries, rankByInstalls } from "./clawhub-catalog-entry.js";
import type {
  ClawHubTemplateCatalogEntry,
  ClawHubTemplateCatalogOverview,
} from "./clawhub-catalog-types.js";
import { fetchRankedTemplatePage, LEGACY_TEMPLATE_CURSOR_PREFIX } from "./clawhub-ranked-page.js";
import { ClawHubSourceError } from "./clawhub-source-artifact.js";
const CATALOG_PAGE_SIZE = 20;

/** Only an unavailable endpoint or an explicitly incomplete overview uses legacy shelves. */
export async function readClawHubTemplatesOverview(
  params: ClawHubTemplatesOverviewOptions = {},
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
  const { limit = 8, includeCategoryEntries } = params;
  return {
    featured: projectPublicEntries(result.featured, params.baseUrl).slice(0, limit),
    sections: result.sections.map(({ category, items }) => {
      const projected = projectPublicEntries(items, params.baseUrl);
      if (includeCategoryEntries !== true || result.completeCategoryEntries !== true) {
        return { category, entries: projected.toSorted(rankByInstalls).slice(0, limit) };
      }
      // Match the paginated category list: the last valid row for a package wins before ranking.
      const unique = new Map(projected.map((entry) => [entry.packageName, entry]));
      const ranked = [...unique.values()].toSorted(rankByInstalls);
      return { category, entries: ranked.slice(0, limit), additionalEntries: ranked.slice(limit) };
    }),
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
    LEGACY_TEMPLATE_CURSOR_PREFIX +
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
  if (
    (query || (params.category && !params.featured)) &&
    !params.cursor?.startsWith(LEGACY_TEMPLATE_CURSOR_PREFIX)
  ) {
    const page = await fetchRankedTemplatePage({
      ...params,
      query,
      limit: params.limit ?? CATALOG_PAGE_SIZE,
    });
    if (page) {
      return {
        entries: projectPublicEntries(page.items, params.baseUrl),
        nextCursor: page.nextCursor,
      };
    }
  }
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
