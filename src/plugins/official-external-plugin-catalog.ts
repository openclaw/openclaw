/** Reads official external plugin/channel/provider catalogs into manifest-like metadata. */
import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import officialExternalChannelCatalog from "../../scripts/lib/official-external-channel-catalog.json" with { type: "json" };
import officialExternalPluginCatalog from "../../scripts/lib/official-external-plugin-catalog.json" with { type: "json" };
import officialExternalProviderCatalog from "../../scripts/lib/official-external-provider-catalog.json" with { type: "json" };
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { isRecord } from "../utils.js";
import type {
  PluginManifestChannelConfig,
  PluginManifestContracts,
  PluginPackageInstall,
} from "./manifest.js";

type ManifestKey = typeof MANIFEST_KEY;

export type OfficialExternalProviderAuthChoice = {
  method?: string;
  choiceId?: string;
  deprecatedChoiceIds?: readonly string[];
  choiceLabel?: string;
  choiceHint?: string;
  assistantPriority?: number;
  assistantVisibility?: "visible" | "manual-only";
  groupId?: string;
  groupLabel?: string;
  groupHint?: string;
  optionKey?: string;
  cliFlag?: string;
  cliOption?: string;
  cliDescription?: string;
  onboardingScopes?: readonly ("text-inference" | "image-generation" | "music-generation")[];
};

export type OfficialExternalProviderCatalogProvider = {
  id?: string;
  aliases?: readonly string[];
  name?: string;
  docs?: string;
  categories?: readonly string[];
  envVars?: readonly string[];
  authChoices?: readonly OfficialExternalProviderAuthChoice[];
};

export type OfficialExternalWebSearchProvider = {
  id?: string;
  label?: string;
  hint?: string;
  onboardingScopes?: readonly "text-inference"[];
  requiresCredential?: boolean;
  credentialLabel?: string;
  envVars?: readonly string[];
  placeholder?: string;
  signupUrl?: string;
  docsUrl?: string;
  credentialPath?: string;
  autoDetectOrder?: number;
};

/** Manifest-like metadata stored in official external catalog entries. */
export type OfficialExternalPluginCatalogManifest = {
  plugin?: {
    id?: string;
    label?: string;
  };
  channel?: {
    id?: string;
    label?: string;
    envVars?: readonly string[];
  };
  providers?: readonly OfficialExternalProviderCatalogProvider[];
  webSearchProviders?: readonly OfficialExternalWebSearchProvider[];
  install?: PluginPackageInstall;
  contracts?: PluginManifestContracts;
  channelConfigs?: Record<string, PluginManifestChannelConfig>;
};

/** Raw official external catalog entry loaded from generated catalog JSON. */
export type OfficialExternalPluginCatalogEntry = {
  id?: string;
  title?: string;
  type?: string;
  state?: string;
  publisher?: {
    id?: string;
    trust?: string;
  };
  name?: string;
  version?: string;
  description?: string;
  source?: string;
  kind?: string;
  install?: {
    candidates?: readonly OfficialExternalPluginCatalogInstallCandidate[];
  };
} & Partial<Record<ManifestKey, OfficialExternalPluginCatalogManifest>>;

export type OfficialExternalPluginCatalogInstallCandidate = {
  sourceRef?: string;
  package?: string;
  version?: string;
  integrity?: string;
};

/** Feed-shaped wrapper used by the bundled external plugin catalog fallback. */
export type OfficialExternalPluginCatalogFeed = {
  schemaVersion: 1 | 2;
  id: string;
  generatedAt: string;
  sequence: number;
  description?: string;
  entries: readonly OfficialExternalPluginCatalogEntry[];
};

export type HostedOfficialExternalPluginCatalogMetadata = {
  url: string;
  status: number;
  etag?: string;
  lastModified?: string;
  checksum: string;
};

export type HostedOfficialExternalPluginCatalogLoadResult =
  | {
      source: "hosted";
      entries: OfficialExternalPluginCatalogEntry[];
      feed: OfficialExternalPluginCatalogFeed;
      metadata: HostedOfficialExternalPluginCatalogMetadata;
    }
  | {
      source: "bundled-fallback";
      entries: OfficialExternalPluginCatalogEntry[];
      error: string;
      metadata?: Omit<HostedOfficialExternalPluginCatalogMetadata, "checksum"> & {
        checksum?: string;
      };
    };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type OfficialExternalProviderContract =
  | "embeddingProviders"
  | "mediaUnderstandingProviders"
  | "memoryEmbeddingProviders"
  | "speechProviders"
  | "webFetchProviders";

const OFFICIAL_CATALOG_SOURCES = [
  officialExternalChannelCatalog,
  officialExternalProviderCatalog,
  officialExternalPluginCatalog,
] as const;

const OFFICIAL_EXTERNAL_CATALOG_FEED_SCHEMA_VERSIONS = new Set<unknown>([1, 2]);
export const DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL =
  "https://clawhub.ai/v1/feeds/plugins";
const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_TIMEOUT_MS = 5000;
const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_BYTES = 1024 * 1024;
const DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CHUNK_TIMEOUT_MS = 5000;
const OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST = ["clawhub.ai"];

export function isOfficialExternalPluginCatalogFeed(
  raw: unknown,
): raw is OfficialExternalPluginCatalogFeed {
  if (!isRecord(raw)) {
    return false;
  }
  const sequence = raw.sequence;
  const entries = raw.entries;
  return (
    OFFICIAL_EXTERNAL_CATALOG_FEED_SCHEMA_VERSIONS.has(raw.schemaVersion) &&
    typeof raw.id === "string" &&
    raw.id.trim().length > 0 &&
    typeof raw.generatedAt === "string" &&
    raw.generatedAt.trim().length > 0 &&
    typeof sequence === "number" &&
    Number.isInteger(sequence) &&
    sequence >= 0 &&
    Array.isArray(entries)
  );
}

export function parseOfficialExternalPluginCatalogEntries(
  raw: unknown,
): OfficialExternalPluginCatalogEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry));
  }
  if (isOfficialExternalPluginCatalogFeed(raw)) {
    return raw.entries.filter((entry): entry is OfficialExternalPluginCatalogEntry =>
      isRecord(entry),
    );
  }
  if (!isRecord(raw)) {
    return [];
  }
  if ("schemaVersion" in raw) {
    return [];
  }
  const list = raw.entries ?? raw.packages ?? raw.plugins;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((entry): entry is OfficialExternalPluginCatalogEntry => isRecord(entry));
}

function normalizeHostedCatalogHeader(value: string | null): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized || undefined;
}

function sha256Hex(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function resolveHostedCatalogFeedUrl(feedUrl: string | undefined): URL {
  const raw = feedUrl?.trim() || DEFAULT_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_URL;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("hosted catalog feed URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("hosted catalog feed URL must use HTTPS");
  }
  if (!OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST.includes(parsed.hostname)) {
    throw new Error("hosted catalog feed URL hostname is not allowed");
  }
  return parsed;
}

function parseHostedCatalogContentLength(raw: string | null, maxBytes: number): void {
  const normalized = normalizeOptionalString(raw);
  if (!normalized) {
    return;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new Error("hosted catalog feed has invalid content-length");
  }
  const size = Number(normalized);
  if (!Number.isSafeInteger(size) || size > maxBytes) {
    throw new Error(`hosted catalog feed exceeds ${maxBytes} bytes`);
  }
}

function hasStreamingResponseBody(
  response: Response,
): response is Response & { body: ReadableStream<Uint8Array> } {
  return Boolean(
    response.body && typeof (response.body as { getReader?: unknown }).getReader === "function",
  );
}

async function readHostedCatalogChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  return await new Promise((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };
    timeoutId = setTimeout(() => {
      timedOut = true;
      clear();
      void reader.cancel().catch(() => undefined);
      reject(new Error(`hosted catalog feed read timed out after ${chunkTimeoutMs}ms`));
    }, chunkTimeoutMs);
    void reader.read().then(
      (result) => {
        clear();
        if (!timedOut) {
          resolve(result);
        }
      },
      (err: unknown) => {
        clear();
        if (!timedOut) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
  });
}

async function readHostedCatalogResponseText(params: {
  response: Response;
  maxBytes: number;
  chunkTimeoutMs: number;
}): Promise<string> {
  parseHostedCatalogContentLength(params.response.headers.get("content-length"), params.maxBytes);
  if (!hasStreamingResponseBody(params.response)) {
    const text = await params.response.text();
    if (new TextEncoder().encode(text).byteLength > params.maxBytes) {
      throw new Error(`hosted catalog feed exceeds ${params.maxBytes} bytes`);
    }
    return text;
  }
  const reader = params.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await readHostedCatalogChunkWithTimeout(reader, params.chunkTimeoutMs);
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > params.maxBytes) {
        throw new Error(`hosted catalog feed exceeds ${params.maxBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function bundledOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return OFFICIAL_CATALOG_SOURCES.flatMap((source) =>
    parseOfficialExternalPluginCatalogEntries(source),
  );
}

function dedupeOfficialExternalPluginCatalogEntries(
  entries: OfficialExternalPluginCatalogEntry[],
): OfficialExternalPluginCatalogEntry[] {
  const resolved = new Map<string, OfficialExternalPluginCatalogEntry>();
  for (const entry of entries) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const key = pluginId ? `${entry.kind ?? "plugin"}:${pluginId}` : (entry.name ?? "");
    if (key && !resolved.has(key)) {
      resolved.set(key, entry);
    }
  }
  return [...resolved.values()];
}

function bundledFallbackResult(
  error: unknown,
  metadata?: HostedOfficialExternalPluginCatalogLoadResult["metadata"],
): HostedOfficialExternalPluginCatalogLoadResult {
  return {
    source: "bundled-fallback",
    entries: listOfficialExternalPluginCatalogEntries(),
    error: error instanceof Error ? error.message : String(error),
    ...(metadata ? { metadata } : {}),
  };
}

export async function loadHostedOfficialExternalPluginCatalogEntries(params?: {
  feedUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  chunkTimeoutMs?: number;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
  expectedSha256?: string;
}): Promise<HostedOfficialExternalPluginCatalogLoadResult> {
  let url: URL;
  try {
    url = resolveHostedCatalogFeedUrl(params?.feedUrl);
  } catch (err) {
    return bundledFallbackResult(err);
  }
  const headers = new Headers();
  const ifNoneMatch = normalizeOptionalString(params?.ifNoneMatch);
  const ifModifiedSince = normalizeOptionalString(params?.ifModifiedSince);
  if (ifNoneMatch) {
    headers.set("if-none-match", ifNoneMatch);
  }
  if (ifModifiedSince) {
    headers.set("if-modified-since", ifModifiedSince);
  }
  const metadataBase = (response: Response) => {
    const etag = normalizeHostedCatalogHeader(response.headers.get("etag"));
    const lastModified = normalizeHostedCatalogHeader(response.headers.get("last-modified"));
    return {
      url: url.href,
      status: response.status,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    };
  };
  let response: Response | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    const { fetchWithSsrFGuard } = await import("../infra/net/fetch-guard.js");
    const guarded = await fetchWithSsrFGuard({
      url: url.href,
      fetchImpl: params?.fetchImpl,
      init: { method: "GET", headers },
      requireHttps: true,
      maxRedirects: 2,
      timeoutMs: params?.timeoutMs ?? DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_TIMEOUT_MS,
      policy: { hostnameAllowlist: OFFICIAL_EXTERNAL_PLUGIN_CATALOG_FEED_HOSTNAME_ALLOWLIST },
      auditContext: "official-external-plugin-catalog-feed",
    });
    response = guarded.response;
    release = guarded.release;
    const base = metadataBase(response);
    if (response.status === 304) {
      return bundledFallbackResult(
        "hosted catalog feed returned HTTP 304 without a cached snapshot",
        base,
      );
    }
    if (!response.ok) {
      return bundledFallbackResult(`hosted catalog feed returned HTTP ${response.status}`, base);
    }
    const body = await readHostedCatalogResponseText({
      response,
      maxBytes: params?.maxBytes ?? DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_MAX_BYTES,
      chunkTimeoutMs:
        params?.chunkTimeoutMs ?? DEFAULT_HOSTED_OFFICIAL_EXTERNAL_PLUGIN_CATALOG_CHUNK_TIMEOUT_MS,
    });
    const checksum = sha256Hex(body);
    const expectedSha256 = normalizeOptionalString(params?.expectedSha256);
    if (expectedSha256 && expectedSha256 !== checksum) {
      return bundledFallbackResult(
        `hosted catalog feed checksum mismatch: expected ${expectedSha256}`,
        {
          ...base,
          checksum,
        },
      );
    }
    const raw = JSON.parse(body) as unknown;
    if (!isOfficialExternalPluginCatalogFeed(raw)) {
      return bundledFallbackResult("hosted catalog feed did not match a supported schema version", {
        ...base,
        checksum,
      });
    }
    return {
      source: "hosted",
      entries: dedupeOfficialExternalPluginCatalogEntries(
        parseOfficialExternalPluginCatalogEntries(raw),
      ),
      feed: raw,
      metadata: {
        ...base,
        checksum,
      },
    };
  } catch (err) {
    return bundledFallbackResult(err);
  } finally {
    if (response?.bodyUsed !== true) {
      await response?.body?.cancel().catch(() => undefined);
    }
    await release?.().catch(() => undefined);
  }
}

function normalizeDefaultChoice(value: unknown): PluginPackageInstall["defaultChoice"] | undefined {
  return value === "clawhub" || value === "npm" || value === "local" ? value : undefined;
}

/** Returns manifest metadata from an official external catalog entry when present. */
export function getOfficialExternalPluginCatalogManifest(
  entry: OfficialExternalPluginCatalogEntry,
): OfficialExternalPluginCatalogManifest | undefined {
  const manifest = entry[MANIFEST_KEY];
  return isRecord(manifest) ? manifest : undefined;
}

export function resolveOfficialExternalPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialExternalPluginLookupIds(
  entry: OfficialExternalPluginCatalogEntry,
): string[] {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const lookupIds = [
    normalizeOptionalString(manifest?.plugin?.id),
    normalizeOptionalString(manifest?.channel?.id),
  ];
  for (const provider of manifest?.providers ?? []) {
    lookupIds.push(normalizeOptionalString(provider.id));
    for (const alias of provider.aliases ?? []) {
      lookupIds.push(normalizeOptionalString(alias));
    }
  }
  return uniqueStrings(lookupIds.filter((value): value is string => Boolean(value)));
}

export function resolveOfficialExternalPluginLabel(
  entry: OfficialExternalPluginCatalogEntry,
): string {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.label) ??
    normalizeOptionalString(manifest?.channel?.label) ??
    normalizeOptionalString(manifest?.providers?.[0]?.name) ??
    normalizeOptionalString(entry.name) ??
    resolveOfficialExternalPluginId(entry) ??
    "plugin"
  );
}

export function resolveOfficialExternalPluginInstall(
  entry: OfficialExternalPluginCatalogEntry,
): PluginPackageInstall | null {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const install = manifest?.install;
  const clawhubSpec = normalizeOptionalString(install?.clawhubSpec);
  const npmSpec = normalizeOptionalString(install?.npmSpec) ?? normalizeOptionalString(entry.name);
  const localPath = normalizeOptionalString(install?.localPath);
  if (!clawhubSpec && !npmSpec && !localPath) {
    return null;
  }
  const defaultChoice =
    normalizeDefaultChoice(install?.defaultChoice) ??
    (npmSpec ? "npm" : clawhubSpec ? "clawhub" : localPath ? "local" : undefined);
  return {
    ...(clawhubSpec ? { clawhubSpec } : {}),
    ...(npmSpec ? { npmSpec } : {}),
    ...(localPath ? { localPath } : {}),
    ...(defaultChoice ? { defaultChoice } : {}),
    ...(install?.minHostVersion ? { minHostVersion: install.minHostVersion } : {}),
    ...(install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    ...(install?.allowInvalidConfigRecovery === true ? { allowInvalidConfigRecovery: true } : {}),
  };
}

export function listOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return dedupeOfficialExternalPluginCatalogEntries(bundledOfficialExternalPluginCatalogEntries());
}

/** Resolves official external plugin owners for configured capability provider ids. */
export function resolveOfficialExternalProviderContractPluginIds(params: {
  contract: OfficialExternalProviderContract;
  providerIds: ReadonlySet<string>;
}): string[] {
  const configuredProviderIds = new Set(
    [...params.providerIds]
      .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
  if (configuredProviderIds.size === 0) {
    return [];
  }
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providerIds =
      getOfficialExternalPluginCatalogManifest(entry)?.contracts?.[params.contract];
    if (
      pluginId &&
      providerIds?.some((providerId) => {
        const normalized = normalizeOptionalString(providerId)?.toLowerCase();
        return normalized ? configuredProviderIds.has(normalized) : false;
      })
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official web provider owners from matching documented environment credentials. */
export function resolveOfficialExternalWebProviderContractPluginIdsForEnv(params: {
  contract: OfficialExternalProviderContract;
  env: NodeJS.ProcessEnv;
}): string[] {
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalPluginCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const contractProviderIds = new Set(
      (manifest?.contracts?.[params.contract] ?? [])
        .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
        .filter((providerId): providerId is string => Boolean(providerId)),
    );
    if (
      pluginId &&
      contractProviderIds.size > 0 &&
      manifest?.webSearchProviders?.some((provider) => {
        const providerId = normalizeOptionalString(provider.id)?.toLowerCase();
        return (
          providerId !== undefined &&
          contractProviderIds.has(providerId) &&
          provider.envVars?.some((envVar) => Boolean(params.env[envVar]?.trim()))
        );
      })
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official external plugin owners for configured model provider ids. */
export function resolveOfficialExternalProviderPluginIds(params: {
  providerIds: ReadonlySet<string>;
}): string[] {
  const configuredProviderIds = new Set(
    [...params.providerIds]
      .map((providerId) => normalizeOptionalString(providerId)?.toLowerCase())
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
  if (configuredProviderIds.size === 0) {
    return [];
  }
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalProviderCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providers = getOfficialExternalPluginCatalogManifest(entry)?.providers;
    if (
      pluginId &&
      providers?.some((provider) =>
        [provider.id, ...(provider.aliases ?? [])].some((providerId) => {
          const normalized = normalizeOptionalString(providerId)?.toLowerCase();
          return normalized ? configuredProviderIds.has(normalized) : false;
        }),
      )
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

/** Resolves official external provider owners with configured environment credentials. */
export function resolveOfficialExternalProviderPluginIdsForEnv(env: NodeJS.ProcessEnv): string[] {
  const pluginIds = new Set<string>();
  for (const entry of listOfficialExternalProviderCatalogEntries()) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const providers = getOfficialExternalPluginCatalogManifest(entry)?.providers;
    if (
      pluginId &&
      providers?.some((provider) =>
        provider.envVars?.some((envVar) => Boolean(env[envVar]?.trim())),
      )
    ) {
      pluginIds.add(pluginId);
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

export function listOfficialExternalChannelCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return listOfficialExternalPluginCatalogEntries().filter((entry) =>
    Boolean(getOfficialExternalPluginCatalogManifest(entry)?.channel),
  );
}

export function listOfficialExternalChannelEnvVars(): Array<{
  channelId: string;
  envVars: readonly string[];
}> {
  return listOfficialExternalChannelCatalogEntries().flatMap((entry) => {
    const channel = getOfficialExternalPluginCatalogManifest(entry)?.channel;
    const channelId = normalizeOptionalString(channel?.id)?.toLowerCase();
    const envVars = uniqueStrings(
      (channel?.envVars ?? [])
        .map((envVar) => normalizeOptionalString(envVar))
        .filter((envVar): envVar is string => Boolean(envVar)),
    );
    return channelId && envVars.length > 0 ? [{ channelId, envVars }] : [];
  });
}

export function listOfficialExternalProviderCatalogEntries(): OfficialExternalPluginCatalogEntry[] {
  return listOfficialExternalPluginCatalogEntries().filter(
    (entry) => (getOfficialExternalPluginCatalogManifest(entry)?.providers?.length ?? 0) > 0,
  );
}

export function getOfficialExternalPluginCatalogEntry(
  pluginId: string,
): OfficialExternalPluginCatalogEntry | undefined {
  const normalized = pluginId.trim();
  if (!normalized) {
    return undefined;
  }
  return listOfficialExternalPluginCatalogEntries().find((entry) =>
    resolveOfficialExternalPluginLookupIds(entry).includes(normalized),
  );
}

export function getOfficialExternalPluginCatalogEntryForPackage(
  packageName: string | undefined,
): OfficialExternalPluginCatalogEntry | undefined {
  const normalized = packageName?.trim();
  if (!normalized) {
    return undefined;
  }
  return listOfficialExternalPluginCatalogEntries().find(
    (entry) => normalizeOptionalString(entry.name) === normalized,
  );
}
