// Canonical join between ClawHub discovery identity and Gateway-owned runtime state.
import type {
  CatalogBrowseParams,
  CatalogBrowseResult,
  CatalogEntry,
  CatalogKind,
  CatalogSearchKeywordsParams,
  CatalogSearchKeywordsResult,
} from "../../packages/gateway-protocol/src/schema/catalog.js";
import type {
  PluginCatalogEntry,
  PluginDiscoveryCategory,
  PluginDiscoveryDetail,
  PluginDiscoveryEntry,
  PluginDiscoveryLocalFacts,
  PluginsInspectResult,
  PluginsListResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { comparePluginCatalogEntries } from "../../packages/plugin-package-contract/src/catalog-order.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ClawHubPluginCatalogEntry,
  ClawHubPluginDetail,
} from "../infra/clawhub-plugin-catalog.js";
import type { SkillStatusReport } from "../skills/discovery/status.js";
import { buildPluginCapabilitySummary } from "./capability-summary.js";
import { emptyInstalledPluginComponents } from "./installed-plugin-components.js";
import { projectPluginOverviewCapabilities } from "./installed-plugin-overview.js";

const DISCOVERY_ID_PREFIX = "ch_";
const LOCAL_DISCOVERY_ID_PREFIX = "local_";
const DISCOVERY_ID_PAYLOAD = /^[A-Za-z0-9_-]+$/u;

function normalizedAlias(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function indexClawHubPlugins(
  plugins: readonly PluginCatalogEntry[],
): Map<string, PluginCatalogEntry> {
  const index = new Map<string, PluginCatalogEntry>();
  for (const plugin of plugins) {
    const packageName = localClawHubIdentity(plugin);
    const identity = normalizedAlias(packageName);
    if (identity) {
      index.set(identity, plugin);
    }
  }
  return index;
}

function projectLocalFacts(
  plugin: PluginCatalogEntry | undefined,
  mutationAllowed: boolean,
  remoteInstallable = true,
): PluginDiscoveryLocalFacts {
  if (!plugin) {
    return {
      present: false,
      installed: false,
      enabled: false,
      state: "not-installed",
      action: mutationAllowed ? "install" : "unavailable",
    };
  }
  return {
    present: true,
    installed: plugin.installed,
    enabled: plugin.enabled,
    state: plugin.state,
    pluginId: plugin.id,
    ...(!plugin.installed && plugin.install ? { install: plugin.install } : {}),
    action: plugin.installed
      ? "manage"
      : mutationAllowed && (remoteInstallable || plugin.install)
        ? "install"
        : "unavailable",
  };
}

/** URL-safe route identity. Package aliases remain private to the Gateway join. */
function encodeDiscoveryId(prefix: string, identity: string): string {
  const normalized = identity.trim();
  if (!normalized) {
    throw new Error("Cannot encode an empty plugin discovery identity.");
  }
  return `${prefix}${Buffer.from(normalized, "utf8").toString("base64url")}`;
}

export function encodePluginDiscoveryId(packageName: string): string {
  const normalized = packageName.trim();
  if (!normalized) {
    throw new Error("Cannot encode an empty ClawHub package identity.");
  }
  return encodeDiscoveryId(DISCOVERY_ID_PREFIX, normalized);
}

export function encodeLocalPluginDiscoveryId(identity: string): string {
  return encodeDiscoveryId(LOCAL_DISCOVERY_ID_PREFIX, identity);
}

export function resolvePluginDiscoveryIdentity(
  id: string,
): { origin: "clawhub" | "local"; identity: string } | undefined {
  const prefix = id.startsWith(DISCOVERY_ID_PREFIX)
    ? DISCOVERY_ID_PREFIX
    : id.startsWith(LOCAL_DISCOVERY_ID_PREFIX)
      ? LOCAL_DISCOVERY_ID_PREFIX
      : undefined;
  if (!prefix) {
    return undefined;
  }
  const payload = id.slice(prefix.length);
  if (!payload || !DISCOVERY_ID_PAYLOAD.test(payload)) {
    return undefined;
  }
  try {
    const identity = Buffer.from(payload, "base64url").toString("utf8");
    const encoded = encodeDiscoveryId(prefix, identity);
    return encoded === id
      ? { origin: prefix === DISCOVERY_ID_PREFIX ? "clawhub" : "local", identity }
      : undefined;
  } catch {
    return undefined;
  }
}

export function joinClawHubPluginCatalog(params: {
  remote: readonly ClawHubPluginCatalogEntry[];
  categories?: readonly PluginDiscoveryCategory[];
  local: PluginsListResult;
  includeBundledOnly?: boolean;
  intent?: "all" | "bundled" | "trending" | "official" | "updated" | "featured";
  category?: string;
  query?: string;
  cursor?: string;
}): PluginDiscoveryEntry[] {
  const localIndex = indexClawHubPlugins(params.local.plugins);
  const remote = params.remote.map((plugin) => {
    const localPlugin = localIndex.get(normalizedAlias(plugin.packageName) ?? "");
    // Keep the registry purpose first; later pages must retain known local capabilities.
    const categories = [
      ...new Set([...plugin.categories, ...(localPlugin?.capabilityCategories ?? [])]),
    ];
    return {
      id: encodePluginDiscoveryId(plugin.packageName),
      catalog: {
        name: plugin.displayName,
        packageName: plugin.packageName,
        ...(plugin.summary ? { summary: plugin.summary } : {}),
        family: plugin.family,
        ...(plugin.ownerHandle ? { author: plugin.ownerHandle } : {}),
        official: plugin.isOfficial,
        categories,
        ...categoryPriorityFacts(plugin.packageName, categories, params.categories),
        ...(plugin.iconUrl ? { imageUrl: plugin.iconUrl } : {}),
        ...(plugin.latestVersion ? { latestVersion: plugin.latestVersion } : {}),
        ...(plugin.downloads !== undefined ? { downloads: plugin.downloads } : {}),
        ...(plugin.installs !== undefined ? { installs: plugin.installs } : {}),
        ...(plugin.verificationTier ? { verificationTier: plugin.verificationTier } : {}),
        ...(plugin.featured !== undefined ? { featured: plugin.featured } : {}),
        ...(plugin.trending !== undefined ? { trending: plugin.trending } : {}),
        ...(plugin.featuredRank !== undefined ? { featuredRank: plugin.featuredRank } : {}),
        ...(plugin.trendingRank !== undefined ? { trendingRank: plugin.trendingRank } : {}),
        publishedToClawHub: true,
      },
      local: projectLocalFacts(localPlugin, params.local.mutationAllowed),
    };
  });
  if ((!params.includeBundledOnly && params.intent !== "all") || params.cursor) {
    return remote;
  }
  const publishedPackages = new Set(
    params.remote.map((plugin) => normalizedAlias(plugin.packageName)),
  );
  const query = normalizedAlias(params.query);
  const localOnly = params.local.plugins
    .filter(
      (plugin) =>
        !publishedPackages.has(normalizedAlias(localClawHubIdentity(plugin))) &&
        ((params.intent === "all" &&
          plugin.installed &&
          (!params.categories ||
            params.query?.trim() ||
            plugin.capabilityCategories?.some(
              (category) => !params.category || category === params.category,
            ))) ||
          (params.includeBundledOnly &&
            plugin.origin === "bundled" &&
            (params.intent !== "bundled" || !localClawHubIdentity(plugin)))),
    )
    .filter((plugin) => {
      const categories = localDiscoveryCategories(plugin);
      if (params.category && !categories.includes(params.category)) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [plugin.id, plugin.packageName, plugin.name, plugin.description, ...categories]
        .flatMap((value) => (value ? [value.toLowerCase()] : []))
        .some((value) => value.includes(query));
    })
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((plugin) =>
      projectLocalDiscoveryEntry(
        plugin,
        params.local.mutationAllowed,
        params.includeBundledOnly && plugin.origin === "bundled",
        params.categories,
      ),
    );
  const joined = [...localOnly, ...remote];
  return params.intent === "all" && !query
    ? joined.toSorted((left, right) => comparePluginCatalogEntries(left, right, params.category))
    : joined;
}

function localDiscoveryCategories(plugin: PluginCatalogEntry): string[] {
  return [
    ...new Set([
      ...(plugin.categories ?? (plugin.category ? [plugin.category] : [])),
      ...(plugin.capabilityCategories ?? []),
    ]),
  ];
}

function localClawHubIdentity(plugin: PluginCatalogEntry): string | undefined {
  return (
    plugin.clawhubPackage ??
    (plugin.install?.source === "clawhub" ? plugin.install.packageName : undefined)
  );
}

function projectLocalDiscoveryEntry(
  plugin: PluginCatalogEntry,
  mutationAllowed: boolean,
  publicationVerified = false,
  categories?: readonly PluginDiscoveryCategory[],
): PluginDiscoveryEntry {
  const clawhubIdentity = localClawHubIdentity(plugin);
  const publishedToClawHub = clawhubIdentity ? true : publicationVerified ? false : undefined;
  const packageName = plugin.clawhubPackage ?? plugin.packageName;
  // Distribution provenance is host-owned; an npm scope alone proves no publisher.
  const official = plugin.origin === "bundled";
  return {
    id: clawhubIdentity
      ? encodePluginDiscoveryId(clawhubIdentity)
      : encodeLocalPluginDiscoveryId(plugin.id),
    catalog: {
      name: plugin.name,
      ...(packageName ? { packageName } : {}),
      ...(plugin.description ? { summary: plugin.description } : {}),
      official,
      ...(official ? { author: "openclaw" } : {}),
      categories: localDiscoveryCategories(plugin),
      ...(official
        ? categoryPriorityFacts(packageName, localDiscoveryCategories(plugin), categories)
        : {}),
      ...(publishedToClawHub !== undefined ? { publishedToClawHub } : {}),
      ...(plugin.version ? { latestVersion: plugin.version } : {}),
    },
    local: projectLocalFacts(plugin, mutationAllowed, false),
  };
}

function categoryPriorityFacts(
  packageName: string | undefined,
  memberships: readonly string[],
  categories: readonly PluginDiscoveryCategory[] = [],
): { categoryRanks?: Record<string, number> } {
  // Only registry projections and host-owned bundled identities enter this policy join.
  const ranks = categories.flatMap((category) => {
    const rank =
      packageName && memberships.includes(category.slug)
        ? (category.pinnedPackages?.indexOf(packageName) ?? -1)
        : -1;
    return rank >= 0 ? [[category.slug, rank] as const] : [];
  });
  return ranks.length ? { categoryRanks: Object.fromEntries(ranks) } : {};
}

export function findLocalPluginByIdentity(
  local: PluginsListResult,
  identity: string,
  origin: "clawhub" | "local" = "clawhub",
): PluginCatalogEntry | undefined {
  return origin === "local"
    ? local.plugins.find((plugin) => plugin.id === identity)
    : indexClawHubPlugins(local.plugins).get(normalizedAlias(identity) ?? "");
}

export function joinLocalPluginDetail(params: {
  plugin: PluginCatalogEntry;
  local: PluginsListResult;
  inspection?: PluginsInspectResult;
}): { plugin: PluginDiscoveryEntry; detail: PluginDiscoveryDetail } {
  const plugin = projectLocalDiscoveryEntry(params.plugin, params.local.mutationAllowed);
  const inspection = params.inspection;
  const capabilities = inspection?.overview?.capabilities;
  const contracts = { ...capabilities?.contracts };
  // The declared tool union also includes names supplied only by tool metadata.
  if (inspection?.declared.tools.length) {
    contracts.tools = inspection.declared.tools;
  }
  return {
    plugin,
    detail: {
      origin: "local",
      ...(plugin.catalog.official
        ? { author: { handle: "openclaw", displayName: "OpenClaw", official: true } }
        : inspection?.overview?.publisherName
          ? { author: { displayName: inspection.overview.publisherName } }
          : {}),
      ...(params.plugin.packageName ? { packageName: params.plugin.packageName } : {}),
      topics: [],
      ...(inspection?.overview?.readme ? { readme: inspection.overview.readme } : {}),
      ...(inspection?.overview?.repositoryUrl
        ? { repositoryUrl: inspection.overview.repositoryUrl }
        : {}),
      ...(inspection?.overview?.documentationUrl
        ? { documentationUrl: inspection.overview.documentationUrl }
        : {}),
      ...(Object.keys(contracts).length ? { contracts } : {}),
      ...(capabilities?.providers.length ? { providers: capabilities.providers } : {}),
      ...(capabilities?.channels.length ? { channels: capabilities.channels } : {}),
      ...(capabilities?.ui !== undefined ? { uiCapabilities: capabilities.ui } : {}),
      configuration: [],
      mcpServers: inspection?.components.mcpServers ?? [],
      skills: (inspection?.components.skills ?? []).map((name) => ({ name })),
      versions: [],
      selectedRelease: null,
      downloadability: {
        status: "unknown",
        reason: "Local metadata does not establish ClawHub release downloadability.",
      },
    },
  };
}

export function joinClawHubPluginDetail(params: {
  remote: ClawHubPluginDetail;
  local: PluginsListResult;
}): { plugin: PluginDiscoveryEntry; detail: PluginDiscoveryDetail } {
  const [plugin] = joinClawHubPluginCatalog({ remote: [params.remote], local: params.local });
  if (!plugin) {
    throw new Error("ClawHub returned no plugin detail.");
  }
  const detail: PluginDiscoveryDetail = {
    origin: "clawhub",
    packageName: params.remote.packageName,
    registry: params.remote.registry,
    tags: params.remote.tags,
    selectedRelease: params.remote.selectedRelease,
    downloadability: params.remote.downloadability,
    metadata: params.remote.metadata,
    ...(params.remote.owner ? { author: params.remote.owner } : {}),
    topics: params.remote.topics,
    ...(params.remote.createdAt !== undefined ? { createdAt: params.remote.createdAt } : {}),
    ...(params.remote.updatedAt !== undefined ? { updatedAt: params.remote.updatedAt } : {}),
    ...(params.remote.readme ? { readme: params.remote.readme } : {}),
    ...(params.remote.repositoryUrl ? { repositoryUrl: params.remote.repositoryUrl } : {}),
    ...(params.remote.documentationUrl ? { documentationUrl: params.remote.documentationUrl } : {}),
    ...(params.remote.compatibility ? { compatibility: params.remote.compatibility } : {}),
    ...(params.remote.contracts ? { contracts: params.remote.contracts } : {}),
    ...(params.remote.providers ? { providers: params.remote.providers } : {}),
    ...(params.remote.channels ? { channels: params.remote.channels } : {}),
    ...(params.remote.uiCapabilities !== undefined
      ? { uiCapabilities: params.remote.uiCapabilities }
      : {}),
    configuration: params.remote.configFields,
    mcpServers: params.remote.mcpServers,
    ...(params.remote.mcpServerDetails ? { mcpServerDetails: params.remote.mcpServerDetails } : {}),
    skills: params.remote.skills,
    versions: params.remote.versions,
    ...(params.remote.verification ? { verification: params.remote.verification } : {}),
    ...(params.remote.security ? { security: params.remote.security } : {}),
  };
  return { plugin, detail };
}

/** Project advisory registry metadata without issuing package capability consent. */
export function projectClawHubPluginInspection(params: {
  remote: ClawHubPluginDetail;
  local: PluginsListResult;
  config: OpenClawConfig;
}): PluginsInspectResult {
  const { remote, local, config } = params;
  const localPlugin = findLocalPluginByIdentity(local, remote.packageName);
  const installedPlugin = localPlugin?.installed ? localPlugin : undefined;
  const runtimePlugin = remote.runtimeId
    ? findLocalPluginByIdentity(
        { ...local, plugins: local.plugins.filter((plugin) => plugin.id === remote.runtimeId) },
        remote.packageName,
      )
    : undefined;
  const summary = buildPluginCapabilitySummary({
    manifest: {
      contracts: remote.contracts,
      channels: remote.channels,
      providers: remote.providers,
      mcpServers: Object.fromEntries(remote.mcpServers.map((name) => [name, {}])),
      skills: remote.skills.map((skill) => skill.name),
    },
    origin: "global",
    entryConfig: runtimePlugin?.installed ? config.plugins?.entries?.[runtimePlugin.id] : undefined,
  });
  const catalog = joinClawHubPluginDetail({ remote, local });
  return {
    ok: true,
    plugin: {
      id: installedPlugin?.id ?? catalog.plugin.id,
      name: remote.displayName,
      ...(remote.selectedRelease ? { version: remote.selectedRelease.version } : {}),
      ...(remote.summary ? { description: remote.summary } : {}),
      origin: "clawhub",
      installed: Boolean(installedPlugin),
      enabled: installedPlugin?.enabled ?? false,
    },
    source: {
      kind: "clawhub",
      packageName: remote.packageName,
    },
    ...summary,
    // Registry summaries omit package siblings and some declared capability groups.
    // Only staged or installed package inspection can issue capability consent.
    declaredSurfaceStatus: remote.metadata.manifest === "available" ? "partial" : "unavailable",
    components: emptyInstalledPluginComponents(),
    overview: {
      ...(remote.metadata.manifest === "available"
        ? {
            capabilities: projectPluginOverviewCapabilities(
              summary.declared,
              remote.uiCapabilities,
            ),
          }
        : {}),
      ...(remote.readme ? { readme: remote.readme } : {}),
      ...(remote.repositoryUrl ? { repositoryUrl: remote.repositoryUrl } : {}),
      ...(remote.documentationUrl ? { documentationUrl: remote.documentationUrl } : {}),
      ...(remote.owner?.displayName ? { publisherName: remote.owner.displayName } : {}),
    },
    ...(remote.trust ? { trust: remote.trust } : {}),
    catalog,
  };
}

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
    kinds.includes("plugin")
      ? import("./management-service.js").then(({ listManagedPlugins }) =>
          listManagedPlugins({ config: scope.config }),
        )
      : undefined,
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
  if (mode === "search" && (request.cursor || request.feed === "trending")) {
    throw new CatalogDiscoveryRequestError(
      "Search accepts neither a browse cursor nor the trending feed.",
    );
  }
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
