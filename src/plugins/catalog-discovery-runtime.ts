// Discovery I/O stays outside the metadata projections shared with plugin management.
import type {
  CatalogBrowseParams,
  CatalogBrowseResult,
  CatalogEntry,
  CatalogKind,
  CatalogSearchKeywordsParams,
  CatalogSearchKeywordsResult,
} from "../../packages/gateway-protocol/src/schema/catalog.js";
import type { PluginsListResult } from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SkillStatusReport } from "../skills/discovery/status.js";
import { joinClawHubPluginCatalog } from "./catalog-discovery.js";
import { listManagedPlugins } from "./management-service.js";

export class CatalogDiscoveryRequestError extends Error {}

const CATALOG_SEARCH_LIMIT = 100;
const CATALOG_SEARCH_CONCURRENCY = 4;

type CatalogScope = {
  config: OpenClawConfig;
  agentId?: string;
  workspaceDir?: string;
};
type CatalogLocalState = {
  plugins?: PluginsListResult;
  skills?: SkillStatusReport;
};

async function prepareCatalogLocalState(
  scope: CatalogScope,
  kinds: readonly CatalogKind[],
): Promise<CatalogLocalState> {
  const [plugins, skills] = await Promise.all([
    kinds.includes("plugin") ? listManagedPlugins({ config: scope.config }) : undefined,
    kinds.includes("skill")
      ? import("../skills/discovery/status.js").then(async ({ prepareWorkspaceSkillStatus }) => {
          if (!scope.agentId || !scope.workspaceDir) {
            throw new CatalogDiscoveryRequestError("Skill discovery requires an agent workspace.");
          }
          return (
            await prepareWorkspaceSkillStatus(scope.workspaceDir, {
              config: scope.config,
              agentId: scope.agentId,
            })
          ).report;
        })
      : undefined,
  ]);
  return { plugins, skills };
}

async function readCatalogPage(params: {
  request: CatalogBrowseParams;
  local: CatalogLocalState;
}): Promise<{
  items: CatalogEntry[];
  nextCursor?: string;
}> {
  const { request, local } = params;
  const { resolveClawHubBaseUrl } = await import("../infra/clawhub-client.js");
  const registry = resolveClawHubBaseUrl();
  const query = request.query?.trim();
  const limit = request.pageSize ?? 20;
  let items: CatalogEntry[];
  let nextCursor: string | undefined;
  if (request.kind === "plugin") {
    const { fetchClawHubPluginCatalog } = await import("../infra/clawhub-plugin-catalog.js");
    const remote = await fetchClawHubPluginCatalog({
      query,
      intent: request.feed === "trending" ? "trending" : "all",
      officialOnly: request.officialOnly,
      cursor: request.cursor,
      limit,
    });
    if (!local.plugins) {
      throw new Error("Plugin installation status is unavailable.");
    }
    // Join only registry listings. Bundled provenance cannot qualify an official catalog result.
    items = joinClawHubPluginCatalog({ remote: remote.items, local: local.plugins }).map((entry) =>
      Object.assign({ kind: "plugin" as const, registry }, entry),
    );
    nextCursor = remote.nextCursor;
  } else {
    const { fetchClawHubSkillCatalog } = await import("../infra/clawhub-skills.js");
    const remote = await fetchClawHubSkillCatalog({
      query,
      feed: request.feed,
      officialOnly: request.officialOnly,
      cursor: request.cursor,
      limit,
    });
    const report = local.skills;
    if (!report?.agentId) {
      throw new Error("Skill installation status is unavailable.");
    }
    const agentId = report.agentId;
    const installed = new Map(
      report.skills.flatMap((skill) => {
        const link = skill.clawhub;
        if (!link?.valid) {
          return [];
        }
        const ref =
          link.requestedReference ??
          (link.ownerHandle ? `@${link.ownerHandle}/${link.slug}` : undefined);
        return ref ? [[JSON.stringify([link.registry, ref]), skill] as const] : [];
      }),
    );
    items = remote.items.map((entry) => {
      const skill = installed.get(JSON.stringify([entry.registry, entry.installRef]));
      return {
        kind: "skill",
        registry: entry.registry,
        id: entry.installRef,
        installRef: entry.installRef,
        slug: entry.slug,
        ...(entry.ownerHandle !== undefined ? { ownerHandle: entry.ownerHandle } : {}),
        ...(entry.installOnly ? { installOnly: entry.installOnly } : {}),
        ...(entry.trustState ? { trustState: entry.trustState } : {}),
        catalog: {
          name: entry.displayName,
          official: entry.official === true,
          categories: [],
          ...(entry.summary ? { summary: entry.summary } : {}),
          ...(entry.ownerHandle ? { author: entry.ownerHandle } : {}),
          ...(entry.icon ? { imageUrl: entry.icon } : {}),
          ...(entry.version ? { latestVersion: entry.version } : {}),
          publishedToClawHub: !entry.installOnly,
        },
        local: {
          agentId,
          installed: skill !== undefined,
          enabled: skill !== undefined && !skill.disabled,
          eligible: skill?.eligible === true && !skill.blockedByAgentFilter,
          ...(skill ? { skillKey: skill.skillKey } : {}),
        },
      };
    });
    nextCursor = remote.nextCursor;
  }
  const unique = new Map(
    items
      .filter((entry) => !request.officialOnly || entry.catalog.official)
      .map((entry) => [JSON.stringify([entry.kind, entry.registry, entry.id]), entry]),
  );
  return { items: [...unique.values()].slice(0, limit), ...(nextCursor ? { nextCursor } : {}) };
}

export async function browseClawHubCatalog(
  params: CatalogScope & {
    request: CatalogBrowseParams;
  },
): Promise<CatalogBrowseResult> {
  const { request } = params;
  const mode = request.query?.trim() ? "search" : (request.feed ?? "catalog");
  const local = await prepareCatalogLocalState(params, [request.kind]);
  const searchFacts = mode === "search" ? { searchLimit: request.pageSize ?? 20 } : {};
  try {
    const page = await readCatalogPage({ request, local });
    const { registerClawHubCatalogIconUrls } = await import("./catalog-icon-registry.js");
    registerClawHubCatalogIconUrls(page.items.map((entry) => entry.catalog.imageUrl));
    return { ...page, mode, ...searchFacts };
  } catch (error) {
    const { formatErrorMessage } = await import("../infra/errors.js");
    return {
      items: [],
      mode,
      ...searchFacts,
      ...(request.cursor ? { nextCursor: request.cursor } : {}),
      remoteError: `ClawHub discovery is unavailable: ${formatErrorMessage(error)}. Retry this request.`,
    };
  }
}

export async function searchClawHubCatalogKeywords(
  params: CatalogScope & {
    request: CatalogSearchKeywordsParams;
  },
): Promise<CatalogSearchKeywordsResult> {
  const { createHash } = await import("node:crypto");
  const { resolveClawHubBaseUrl } = await import("../infra/clawhub-client.js");
  const { formatErrorMessage } = await import("../infra/errors.js");
  const { request } = params;
  const keywords = [
    ...new Set(request.keywords.map((term) => term.trim().replace(/\s+/gu, " ").toLowerCase())),
  ].toSorted();
  const kinds = (request.kinds ?? ["plugin", "skill"]).toSorted();
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const key = hash([keywords, kinds, resolveClawHubBaseUrl(), params.agentId, params.workspaceDir]);
  let offset = 0;
  if (request.cursor) {
    const match = /^kw1\.([a-f0-9]{64})\.([a-f0-9]{64})\.(\d{1,5})$/u.exec(request.cursor);
    if (!match || match[1] !== key || Number(match[3]) > 20_000) {
      throw new CatalogDiscoveryRequestError(
        "Invalid keyword cursor. Restart discovery with the same keywords and agent.",
      );
    }
    offset = Number(match[3]);
  }
  const local = await prepareCatalogLocalState(params, kinds);
  const queries = keywords.flatMap((query) => kinds.map((kind) => ({ kind, query })));
  const results: Awaited<ReturnType<typeof readCatalogPage>>[] = [];
  const errors: CatalogSearchKeywordsResult["errors"] = [];
  let nextQuery = 0;
  await Promise.all(
    Array.from({ length: Math.min(CATALOG_SEARCH_CONCURRENCY, queries.length) }, async () => {
      while (nextQuery < queries.length) {
        const index = nextQuery++;
        const query = queries[index]!;
        try {
          results[index] = await readCatalogPage({
            request: { ...query, officialOnly: true, pageSize: CATALOG_SEARCH_LIMIT },
            local,
          });
        } catch (error) {
          results[index] = { items: [] };
          errors.push({ ...query, message: formatErrorMessage(error) });
        }
      }
    }),
  );
  const union = new Map(
    results.flatMap((page) =>
      page.items.map(
        (entry) => [JSON.stringify([entry.kind, entry.registry, entry.id]), entry] as const,
      ),
    ),
  );
  const identities = [...union.keys()].toSorted();
  // Pagination is best effort if the remote catalog changes between requests.
  const signature = hash(identities);
  const pageSize = request.pageSize ?? 20;
  const items = identities.slice(offset, offset + pageSize).map((id) => union.get(id)!);
  const { registerClawHubCatalogIconUrls } = await import("./catalog-icon-registry.js");
  registerClawHubCatalogIconUrls(items.map((entry) => entry.catalog.imageUrl));
  return {
    items,
    keywords,
    searchLimit: CATALOG_SEARCH_LIMIT,
    errors: errors.toSorted(
      (a, b) => a.kind.localeCompare(b.kind) || a.query.localeCompare(b.query),
    ),
    ...(offset + pageSize < identities.length
      ? { nextCursor: `kw1.${key}.${signature}.${offset + pageSize}` }
      : {}),
  };
}
