import { readConfigFileSnapshot } from "../config/config.js";
import { isRecord } from "../shared/record-coerce.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { theme } from "../terminal/theme.js";

type FeedEntryType = "skill" | "plugin";

type FeedEntryResult = {
  readonly type: FeedEntryType;
  readonly id: string;
  readonly sourceId: string;
  readonly feedId: string;
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly install?: unknown;
};

type FeedSearchApi = {
  readonly searchConfiguredFeedEntries: (options: {
    readonly query?: string;
    readonly type?: FeedEntryType;
    readonly sourceIds?: readonly string[];
    readonly limit?: number;
  }) => Promise<readonly FeedEntryResult[]>;
};

export type CatalogFeedSearchCliOptions = {
  catalogFeeds?: boolean;
  feedSource?: string[];
};

export function splitFeedSourceIds(values: string[] | undefined): string[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  const ids = values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
  return ids.length === 0 ? undefined : [...new Set(ids)];
}

export async function shouldSearchCatalogFeeds(
  opts: CatalogFeedSearchCliOptions,
): Promise<boolean> {
  return (await resolveCatalogFeedSearchOptions(opts)).enabled;
}

export async function resolveCatalogFeedSearchOptions(opts: CatalogFeedSearchCliOptions): Promise<{
  enabled: boolean;
  sourceIds?: string[];
}> {
  const cliSourceIds = splitFeedSourceIds(opts.feedSource);
  if (opts.catalogFeeds === true || cliSourceIds !== undefined) {
    if (!(await readFeedPluginEnabledForSearch())) {
      throw new Error(
        "Catalog feed search requires the Feeds plugin to be enabled and allowed in config.",
      );
    }
    return { enabled: true, sourceIds: cliSourceIds };
  }
  return readDefaultCatalogFeedSearchOptions();
}

export async function searchCatalogFeedEntriesForCli(params: {
  queryParts: string[] | string;
  type: FeedEntryType;
  limit?: number;
  opts: CatalogFeedSearchCliOptions;
}): Promise<readonly FeedEntryResult[]> {
  const searchOptions = await resolveCatalogFeedSearchOptions(params.opts);
  if (!searchOptions.enabled) {
    return [];
  }
  const { loadBundledPluginPublicArtifactModuleSync } =
    await import("../plugins/public-surface-loader.js");
  const { searchConfiguredFeedEntries } = loadBundledPluginPublicArtifactModuleSync<FeedSearchApi>({
    dirName: "feeds",
    artifactBasename: "api.js",
  });
  return searchConfiguredFeedEntries({
    query: normalizeOptionalString(
      Array.isArray(params.queryParts) ? params.queryParts.join(" ") : params.queryParts,
    ),
    type: params.type,
    sourceIds: searchOptions.sourceIds,
    limit: params.limit,
  });
}

export function formatFeedSearchEntry(entry: FeedEntryResult): string {
  const version = entry.version === undefined ? "" : ` v${entry.version}`;
  const name = entry.name === undefined ? entry.id : entry.name;
  const summary = entry.description === undefined ? "" : theme.muted(` - ${entry.description}`);
  const install = feedInstallHint(entry);
  return `${entry.id}${version}  ${name}${summary}\n  ${theme.muted(`Feed: ${entry.sourceId}/${entry.feedId}`)}${install}`;
}

function feedInstallHint(entry: FeedEntryResult): string {
  const command = formatFeedInstallCommandForSearch(entry);
  return command === undefined ? "" : `\n  ${theme.muted(`Install: ${command}`)}`;
}

function formatFeedInstallCommandForSearch(entry: FeedEntryResult): string | undefined {
  const install = isRecord(entry.install) ? entry.install : {};
  const source = typeof install.source === "string" ? install.source : undefined;
  const spec = typeof install.spec === "string" ? install.spec.trim() : "";
  const clawhubSpec = typeof install.clawhubSpec === "string" ? install.clawhubSpec.trim() : "";
  const npmSpec = typeof install.npmSpec === "string" ? install.npmSpec.trim() : "";
  const slug = typeof install.slug === "string" ? install.slug.trim() : "";
  if (entry.type === "plugin") {
    const resolvedSpec =
      (clawhubSpec ? normalizeClawHubSpec(clawhubSpec) : "") ||
      (source === "clawhub" && spec ? normalizeClawHubSpec(spec) : "") ||
      npmSpec ||
      ((source === "npm" || source === "path" || source === "git") && spec ? spec : "");
    return resolvedSpec ? formatOpenClawCommand(["plugins", "install", resolvedSpec]) : undefined;
  }
  if (entry.type === "skill") {
    const resolvedSpec =
      slug ||
      (source === "clawhub" && spec ? spec.replace(/^clawhub:/u, "") : "") ||
      ((source === "git" || source === "path" || source === "local") && spec ? spec : "");
    return resolvedSpec ? formatOpenClawCommand(["skills", "install", resolvedSpec]) : undefined;
  }
  return undefined;
}

function normalizeClawHubSpec(value: string): string {
  return value.startsWith("clawhub:") ? value : `clawhub:${value}`;
}

function formatOpenClawCommand(argv: readonly string[]): string {
  return ["openclaw", ...argv].map(quoteCliArg).join(" ");
}

function quoteCliArg(value: string): string {
  return /^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\\''") + "'";
}

async function readFeedPluginEnabledForSearch(): Promise<boolean> {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return false;
    }
    const plugins = isRecord(snapshot.config.plugins) ? snapshot.config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const feeds = isRecord(entries.feeds) ? entries.feeds : {};
    const config = isRecord(feeds.config) ? feeds.config : {};
    return feedPluginEnabledForDefaultSearch(plugins, feeds, config);
  } catch {
    return false;
  }
}

async function readDefaultCatalogFeedSearchOptions(): Promise<{
  enabled: boolean;
  sourceIds?: string[];
}> {
  try {
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      return { enabled: false };
    }
    const plugins = isRecord(snapshot.config.plugins) ? snapshot.config.plugins : {};
    const entries = isRecord(plugins.entries) ? plugins.entries : {};
    const feeds = isRecord(entries.feeds) ? entries.feeds : {};
    const config = isRecord(feeds.config) ? feeds.config : {};
    if (!feedPluginEnabledForDefaultSearch(plugins, feeds, config)) {
      return { enabled: false };
    }
    const search = isRecord(config.search) ? config.search : {};
    if (search.default !== true) {
      return { enabled: false };
    }
    if (search.sources !== undefined && !Array.isArray(search.sources)) {
      return { enabled: false };
    }
    return {
      enabled: true,
      sourceIds: Array.isArray(search.sources)
        ? search.sources.filter((id): id is string => typeof id === "string")
        : undefined,
    };
  } catch {
    return { enabled: false };
  }
}

function feedPluginEnabledForDefaultSearch(
  plugins: Record<string, unknown>,
  feeds: Record<string, unknown>,
  config: Record<string, unknown>,
): boolean {
  const allow = readStringArray(plugins.allow);
  const deny = readStringArray(plugins.deny);
  return (
    plugins.enabled !== false &&
    feeds.enabled === true &&
    config.enabled !== false &&
    !deny.includes("feeds") &&
    (allow.length === 0 || allow.includes("feeds"))
  );
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
