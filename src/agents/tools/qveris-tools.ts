import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { readResponseBuffer } from "./web-shared.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_DISCOVER_TIMEOUT_SECONDS = 5;
const DEFAULT_CALL_TIMEOUT_SECONDS = 60;
const DEFAULT_MAX_RESPONSE_SIZE = 20480;
const DEFAULT_DISCOVER_LIMIT = 10;

// Full-content materialization defaults
const DEFAULT_FULL_CONTENT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_FULL_CONTENT_TIMEOUT_SECONDS = 30;
const MATERIALIZED_PREVIEW_MAX_CHARS = 800;
const QVERIS_DATA_DIR_NAME = "qveris-data";

export type QverisRegion = "global" | "cn";

export const QVERIS_REGION_DOMAINS: Record<QverisRegion, string> = {
  global: "qveris.ai",
  cn: "qveris.cn",
};

// Short-TTL cache for discover results — avoids redundant API calls within a session
const DEFAULT_DISCOVER_CACHE_TTL_MS = 90_000; // 90 seconds

// ============================================================================
// Types
// ============================================================================

type QverisConfig = NonNullable<OpenClawConfig["tools"]>["qveris"];

/** Discovery result parameter from QVeris API */
interface QverisDiscoverResultParam {
  name: string;
  type: string;
  required: boolean;
  description?: {
    en?: string;
    [key: string]: string | undefined;
  };
}

/** Example format from QVeris discovery API */
interface QverisDiscoverResultExamples {
  sample_parameters?: Record<string, unknown>;
}

/** Discovery result tool from QVeris API */
interface QverisDiscoverResultTool {
  tool_id: string;
  name: string;
  description: string;
  params?: QverisDiscoverResultParam[];
  provider_description?: string;
  stats?: {
    avg_execution_time_ms?: number;
    success_rate?: number;
  };
  examples?: QverisDiscoverResultExamples;
}

/** QVeris discover API response */
interface QverisDiscoverResponse {
  query: string;
  total: number;
  results: QverisDiscoverResultTool[];
  search_id: string; // backend session ID; resolved internally, not exposed to model
  elapsed_time_ms?: number;
}

/** QVeris tool invocation response */
interface QverisInvocationResponse {
  execution_id: string;
  result: {
    data?: unknown;
    status_code?: unknown;
    message?: unknown;
    full_content_file_url?: unknown;
    truncated_content?: unknown;
    content_schema?: unknown;
  };
  success: boolean;
  error_message: string | null;
  elapsed_time_ms: number;
  cost?: number;
  credits_used?: number;
}

/** Content analysis metadata returned in the materialized manifest */
interface ContentAnalysis {
  root_type?: string;
  record_count?: number;
  line_count?: number;
  column_names?: string[];
  fields?: Record<string, string>;
  preview_records?: number;
}

type ContentCategory = "json" | "csv" | "text" | "image" | "audio" | "video" | "binary";

interface MaterializedContentReady {
  status: "ready";
  path: string;
  content_category: ContentCategory;
  mime_type: string;
  file_bytes: number;
  analysis?: ContentAnalysis;
  preview?: string;
  consumption_contract: string;
}

interface MaterializedContentFailed {
  status: "failed";
  reason: string;
  detail?: string;
}

type MaterializedContent = MaterializedContentReady | MaterializedContentFailed;

/**
 * Short reminder appended to error results so the model stays in the tool workflow.
 * Focused on the QVeris API endpoints only — deliberately does not mention
 * full_content_file_url downloads (those are a legitimate exec/web_fetch path
 * returned by qveris_call).
 */
const QVERIS_WORKFLOW_NOTE =
  "Stay inside the QVeris tool workflow (qveris_discover / qveris_call / qveris_inspect). " +
  "Never call /search, /tools/execute, or /tools/by-ids directly. " +
  "Never reveal QVERIS_API_KEY.";

/** Structured error returned to the model instead of throwing */
interface QverisErrorResult {
  success: false;
  error_type:
    | "timeout"
    | "http_error"
    | "network_error"
    | "json_parse_error"
    | "rate_limited"
    | "tool_not_discovered";
  status?: number;
  detail: string;
  retry_hint?: string;
  retry_after_seconds?: number;
  recovery_step?: "fix_params" | "simplify" | "switch_tool";
  attempt_number?: number;
  note?: string;
}

// ============================================================================
// Config Resolution
// ============================================================================

function resolveQverisConfig(cfg?: OpenClawConfig): QverisConfig {
  const toolsConfig = cfg?.tools?.qveris;
  const pluginConfig = cfg?.plugins?.entries?.qveris?.config;
  if (!toolsConfig && !pluginConfig) {
    return undefined;
  }
  // Merge: tools.qveris takes precedence, plugin config is fallback
  return { ...pluginConfig, ...toolsConfig } as NonNullable<QverisConfig>;
}

function resolveQverisEnabled(params: { config?: QverisConfig; sandboxed?: boolean }): boolean {
  if (typeof params.config?.enabled === "boolean") {
    return params.config.enabled;
  }
  return Boolean(resolveQverisApiKey(params.config));
}

function resolveQverisApiKey(config?: QverisConfig): string | undefined {
  const fromConfig =
    config && "apiKey" in config && typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const fromEnv = (process.env.QVERIS_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function resolveQverisRegion(config?: QverisConfig): QverisRegion {
  const r = config && "region" in config ? (config as Record<string, unknown>).region : undefined;
  return r === "cn" ? "cn" : "global";
}

function resolveQverisDomain(config?: QverisConfig): string {
  return QVERIS_REGION_DOMAINS[resolveQverisRegion(config)];
}

function resolveQverisBaseUrl(config?: QverisConfig): string {
  const explicit = config?.baseUrl?.trim();
  if (explicit) {
    return explicit;
  }
  return `https://${resolveQverisDomain(config)}/api/v1`;
}

/**
 * Returns the OSS domain whitelist for full-content downloads.
 * Includes the region domain and, if baseUrl overrides to a different
 * QVeris domain, that domain too — so the whitelist stays consistent
 * with wherever the API is actually pointing.
 */
function resolveFullContentAllowedDomains(config?: QverisConfig): string[] {
  const regionDomain = resolveQverisDomain(config);
  const domains = new Set<string>([regionDomain]);

  const explicit = config?.baseUrl?.trim();
  if (explicit) {
    try {
      const host = new URL(explicit).hostname.toLowerCase();
      const allKnownDomains = Object.values(QVERIS_REGION_DOMAINS);
      const isQverisDomain = allKnownDomains.some((d) => host === d || host.endsWith(`.${d}`));
      if (isQverisDomain) {
        for (const d of allKnownDomains) {
          if (host === d || host.endsWith(`.${d}`)) {
            domains.add(d);
          }
        }
      }
    } catch {
      // invalid baseUrl — ignore, region domain still in the set
    }
  }
  return [...domains];
}

function resolveDiscoverTimeoutSeconds(config?: QverisConfig): number {
  return config?.searchTimeoutSeconds ?? config?.timeoutSeconds ?? DEFAULT_DISCOVER_TIMEOUT_SECONDS;
}

function resolveCallTimeoutSeconds(config?: QverisConfig): number {
  return config?.executeTimeoutSeconds ?? config?.timeoutSeconds ?? DEFAULT_CALL_TIMEOUT_SECONDS;
}

function resolveMaxResponseSize(config?: QverisConfig): number {
  return config?.maxResponseSize ?? DEFAULT_MAX_RESPONSE_SIZE;
}

function resolveDiscoverLimit(config?: QverisConfig): number {
  return config?.searchLimit ?? DEFAULT_DISCOVER_LIMIT;
}

function resolveAutoMaterialize(config?: QverisConfig): boolean {
  if (config && "autoMaterializeFullContent" in config) {
    return config.autoMaterializeFullContent === true;
  }
  return false;
}

function resolveFullContentMaxBytes(config?: QverisConfig): number {
  return (
    ((config && "fullContentMaxBytes" in config
      ? (config as Record<string, unknown>).fullContentMaxBytes
      : undefined) as number | undefined) ?? DEFAULT_FULL_CONTENT_MAX_BYTES
  );
}

function resolveFullContentTimeoutSeconds(config?: QverisConfig): number {
  return (
    ((config && "fullContentTimeoutSeconds" in config
      ? (config as Record<string, unknown>).fullContentTimeoutSeconds
      : undefined) as number | undefined) ?? DEFAULT_FULL_CONTENT_TIMEOUT_SECONDS
  );
}

// ============================================================================
// Error Classification
// ============================================================================

/**
 * Classifies a caught error from a QVeris API call into a structured result
 * so the model receives a consistent error format rather than an exception trace.
 */
export function classifyQverisError(err: unknown, opts?: { note?: string }): QverisErrorResult {
  const note = opts?.note ?? QVERIS_WORKFLOW_NOTE;
  if (err instanceof DOMException && err.name === "AbortError") {
    return {
      success: false,
      error_type: "timeout",
      detail: "Request timed out",
      retry_hint: "Increase timeout_seconds or retry with a simpler query.",
      note,
    };
  }
  if (err instanceof Error && err.name === "AbortError") {
    return {
      success: false,
      error_type: "timeout",
      detail: "Request timed out",
      retry_hint: "Increase timeout_seconds or retry with a simpler query.",
      note,
    };
  }
  if (err instanceof Error) {
    const httpMatch = err.message.match(/\((\d{3})\)/);
    if (httpMatch) {
      const status = Number(httpMatch[1]);

      // Rate-limit: parse Retry-After encoded by the API client
      if (status === 429) {
        const retryMatch = err.message.match(/\[retry-after:(\d+)]/);
        const waitSeconds = retryMatch ? Number(retryMatch[1]) : 10;
        return {
          success: false,
          error_type: "rate_limited",
          status: 429,
          detail: err.message.replace(/\s*\[retry-after:\d+]/, ""),
          retry_after_seconds: waitSeconds,
          retry_hint: `Rate limited. Wait ${waitSeconds}s before retrying.`,
          note,
        };
      }

      const isClientError = status >= 400 && status < 500;
      return {
        success: false,
        error_type: "http_error",
        status,
        detail: err.message,
        retry_hint: isClientError
          ? "Check tool_id and params_to_tool structure. Make sure tool_id came from qveris_discover."
          : "QVeris service error — retry in a moment.",
        note,
      };
    }
    return {
      success: false,
      error_type: "network_error",
      detail: err.message,
      retry_hint: "Check network connectivity and retry.",
      note,
    };
  }
  return {
    success: false,
    error_type: "network_error",
    detail: String(err),
    retry_hint: "Check network connectivity and retry.",
    note,
  };
}

// ============================================================================
// In-Memory Discover Cache
// ============================================================================

interface DiscoverCacheEntry {
  value: ReturnType<typeof jsonResult>;
  expiresAt: number;
}

function makeDiscoverCache() {
  const store = new Map<string, DiscoverCacheEntry>();

  function read(key: string): DiscoverCacheEntry["value"] | undefined {
    const entry = store.get(key);
    if (!entry) {
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function write(key: string, value: DiscoverCacheEntry["value"], ttlMs: number) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  return { read, write };
}

// ============================================================================
// API Client
// ============================================================================

/** Encode Retry-After into the error message so classifyQverisError can parse it */
function buildApiError(label: string, res: Response, detail: string): Error {
  const retryAfter = res.headers.get("Retry-After");
  const retryTag = retryAfter ? ` [retry-after:${retryAfter}]` : "";
  return new Error(
    `QVeris ${label} failed (${res.status}): ${detail || res.statusText}${retryTag}`,
  );
}

async function qverisDiscover(params: {
  query: string;
  sessionId: string;
  limit: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<QverisDiscoverResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(`${params.baseUrl}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        query: params.query,
        limit: params.limit,
        session_id: params.sessionId,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw buildApiError("discover", res, detail);
    }

    return (await res.json()) as QverisDiscoverResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function qverisCall(params: {
  toolId: string;
  searchId?: string;
  sessionId: string;
  parameters: Record<string, unknown>;
  maxResponseSize: number;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<QverisInvocationResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(
      `${params.baseUrl}/tools/execute?tool_id=${encodeURIComponent(params.toolId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        },
        body: JSON.stringify({
          parameters: params.parameters,
          max_response_size: params.maxResponseSize,
          search_id: params.searchId ?? null,
          session_id: params.sessionId,
        }),
        signal: controller.signal,
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw buildApiError("invoke", res, detail);
    }

    return (await res.json()) as QverisInvocationResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** QVeris by-ids API response */
interface QverisGetByIdsResponse {
  tools: QverisDiscoverResultTool[];
}

async function qverisGetByIds(params: {
  toolIds: string[];
  sessionId: string;
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
}): Promise<QverisGetByIdsResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const requestBody = {
      tool_ids: params.toolIds,
      session_id: params.sessionId,
    };

    const res = await fetch(`${params.baseUrl}/tools/by-ids`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw buildApiError("inspect", res, detail);
    }

    return (await res.json()) as QverisGetByIdsResponse;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// Session Tool Rolodex — remembers successfully invoked tools for the session
// ============================================================================

interface RolodexEntry {
  toolId: string;
  name: string;
  description: string;
  successCount: number;
  lastUsedAt: number;
  discoveryQuery: string;
  discoveryId?: string;
}

function makeToolRolodex() {
  const store = new Map<string, RolodexEntry>();

  function record(
    toolId: string,
    meta: { name: string; description: string; discoveryQuery: string; discoveryId?: string },
  ) {
    const existing = store.get(toolId);
    if (existing) {
      existing.successCount += 1;
      existing.lastUsedAt = Date.now();
      existing.discoveryId = meta.discoveryId ?? existing.discoveryId;
    } else {
      store.set(toolId, {
        toolId,
        name: meta.name,
        description: meta.description,
        successCount: 1,
        lastUsedAt: Date.now(),
        discoveryQuery: meta.discoveryQuery,
        discoveryId: meta.discoveryId,
      });
    }
  }

  function lookup(toolId: string): RolodexEntry | undefined {
    return store.get(toolId);
  }

  function getSummary(): Array<{
    tool_id: string;
    name: string;
    uses: number;
  }> {
    return Array.from(store.values()).map((e) => ({
      tool_id: e.toolId,
      name: e.name,
      uses: e.successCount,
    }));
  }

  return { record, lookup, getSummary };
}

// Track which discovery returned which tool_id so we can populate rolodex on call
interface DiscoverResultMeta {
  name: string;
  description: string;
  query: string;
  searchId?: string;
}

function makeDiscoverResultTracker() {
  const store = new Map<string, DiscoverResultMeta>();

  function trackResults(
    query: string,
    tools: Array<{ tool_id: string; name: string; description: string }>,
    searchId?: string,
  ) {
    for (const tool of tools) {
      const existing = store.get(tool.tool_id);
      store.set(tool.tool_id, {
        name: tool.name,
        description: tool.description,
        query: query === "(inspect)" ? (existing?.query ?? query) : query,
        searchId: searchId ?? existing?.searchId,
      });
    }
  }

  function getMeta(toolId: string): DiscoverResultMeta | undefined {
    return store.get(toolId);
  }

  return { trackResults, getMeta };
}

// ============================================================================
// Full-Content Materialization
// ============================================================================

interface DownloadResult {
  /** Raw bytes — always present, preserves binary content byte-for-byte. */
  raw: Uint8Array;
  /** Text decode — only populated when bytes can be safely decoded as UTF-8. */
  text?: string;
  headerMime: string | null;
  bytesRead: number;
  truncatedOnDownload: boolean;
}

function isAllowedFullContentDomain(hostname: string, allowedDomains: string[]): boolean {
  const lower = hostname.toLowerCase();
  return allowedDomains.some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

function tryDecodeUtf8(buffer: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

/**
 * Fetch full result data from a QVeris-provided URL.
 * Security: HTTPS-only, domain-whitelisted, no redirects, no auth forwarding.
 */
async function fetchQverisResultData(params: {
  url: string;
  maxBytes: number;
  timeoutSeconds: number;
  allowedDomains: string[];
}): Promise<DownloadResult> {
  if (!params.url.startsWith("https://")) {
    throw new Error("full_content_file_url must use HTTPS");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error(`full_content_file_url is not a valid URL: ${params.url}`);
  }

  if (!isAllowedFullContentDomain(parsedUrl.hostname, params.allowedDomains)) {
    throw new Error(
      `full_content_file_url domain "${parsedUrl.hostname}" is not in the allowed list ` +
        `(${params.allowedDomains.join(", ")}). Download blocked.`,
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutSeconds * 1000);

  try {
    const res = await fetch(params.url, {
      signal: controller.signal,
      redirect: "error",
    });

    if (!res.ok) {
      throw new Error(`Full-content download failed (${res.status}): ${res.statusText}`);
    }

    const headerMime = res.headers.get("content-type");
    const category = classifyContentCategory(
      headerMime ? headerMime.split(";")[0].trim() : undefined,
    );
    const { buffer, truncated, bytesRead } = await readResponseBuffer(res, {
      maxBytes: params.maxBytes,
    });
    // Keep raw bytes for all downloads. Only derive text when the payload is
    // safely decodable as UTF-8, so unknown MIME types can still be
    // reclassified as JSON without corrupting true binary content.
    const text =
      category === "image" || category === "audio" || category === "video"
        ? undefined
        : tryDecodeUtf8(buffer);
    return { raw: buffer, text, headerMime, bytesRead, truncatedOnDownload: truncated };
  } finally {
    clearTimeout(timeoutId);
  }
}

function classifyContentCategory(mimeType: string | undefined): ContentCategory {
  if (!mimeType) {
    return "binary";
  }
  const lower = mimeType.toLowerCase().split(";")[0].trim();
  if (lower === "application/json" || lower.endsWith("+json")) {
    return "json";
  }
  if (lower === "text/csv" || lower === "application/csv") {
    return "csv";
  }
  if (lower.startsWith("text/")) {
    return "text";
  }
  if (lower.startsWith("image/")) {
    return "image";
  }
  if (lower.startsWith("audio/")) {
    return "audio";
  }
  if (lower.startsWith("video/")) {
    return "video";
  }
  return "binary";
}

function inferFieldType(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "array";
    }
    const first = value[0];
    return `${typeof first === "object" && first !== null ? "object" : typeof first}[]`;
  }
  if (typeof value === "object") {
    return "object";
  }
  return typeof value;
}

export function inferJsonAnalysis(
  text: string,
  maxPreviewChars: number,
): ContentAnalysis & { preview?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }

  if (Array.isArray(parsed)) {
    const fields: Record<string, string> = {};
    const sample = parsed[0];
    if (sample && typeof sample === "object" && sample !== null) {
      for (const [key, val] of Object.entries(sample as Record<string, unknown>)) {
        fields[key] = inferFieldType(val);
      }
    }
    const previewSlice = parsed.slice(0, 2);
    let preview = JSON.stringify(previewSlice);
    if (preview.length > maxPreviewChars) {
      preview = preview.slice(0, maxPreviewChars) + "...";
    }
    return {
      root_type: "array",
      record_count: parsed.length,
      fields: Object.keys(fields).length > 0 ? fields : undefined,
      preview_records: Math.min(2, parsed.length),
      preview,
    };
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys: Record<string, string> = {};
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(val)) {
        keys[key] = `array[${val.length}]`;
      } else {
        keys[key] = inferFieldType(val);
      }
    }
    let preview = JSON.stringify(parsed, null, 2);
    if (preview.length > maxPreviewChars) {
      preview = preview.slice(0, maxPreviewChars) + "...";
    }
    return {
      root_type: "object",
      fields: Object.keys(keys).length > 0 ? keys : undefined,
      preview,
    };
  }

  return {};
}

function inferCsvAnalysis(
  text: string,
  maxPreviewChars: number,
): ContentAnalysis & { preview?: string } {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { line_count: 0 };
  }

  const firstLine = lines[0];
  const delimiter = firstLine.includes("\t") ? "\t" : ",";
  const columnNames = firstLine.split(delimiter).map((c) => c.trim().replace(/^["']|["']$/g, ""));

  const previewLines = lines.slice(0, 5);
  let preview = previewLines.join("\n");
  if (preview.length > maxPreviewChars) {
    preview = preview.slice(0, maxPreviewChars) + "...";
  }

  return {
    line_count: lines.length,
    column_names: columnNames,
    preview,
  };
}

function inferTextAnalysis(
  text: string,
  maxPreviewChars: number,
): ContentAnalysis & { preview?: string } {
  const lines = text.split("\n");
  let preview = text.slice(0, maxPreviewChars);
  if (text.length > maxPreviewChars) {
    preview += "...";
  }
  return {
    line_count: lines.length,
    preview,
  };
}

function buildContentAnalysis(
  text: string,
  category: ContentCategory,
  maxPreviewChars: number,
): { analysis?: ContentAnalysis; preview?: string } {
  let raw: ContentAnalysis & { preview?: string };
  switch (category) {
    case "json":
      raw = inferJsonAnalysis(text, maxPreviewChars);
      break;
    case "csv":
      raw = inferCsvAnalysis(text, maxPreviewChars);
      break;
    case "text":
      raw = inferTextAnalysis(text, maxPreviewChars);
      break;
    default:
      return {};
  }
  const { preview, ...rest } = raw;
  const analysis = Object.keys(rest).length > 0 ? rest : undefined;
  return { analysis, preview };
}

function resolveExtensionForMime(mime: string | undefined): string {
  if (!mime) {
    return ".bin";
  }
  const lower = mime.toLowerCase().split(";")[0].trim();
  if (lower === "application/json" || lower.endsWith("+json")) {
    return ".json";
  }
  if (lower === "text/csv" || lower === "application/csv") {
    return ".csv";
  }
  if (lower === "text/plain") {
    return ".txt";
  }
  if (lower === "text/html") {
    return ".html";
  }
  if (lower === "text/xml" || lower === "application/xml") {
    return ".xml";
  }
  if (lower.startsWith("image/png")) {
    return ".png";
  }
  if (lower.startsWith("image/jpeg")) {
    return ".jpg";
  }
  if (lower.startsWith("image/gif")) {
    return ".gif";
  }
  if (lower.startsWith("image/webp")) {
    return ".webp";
  }
  if (lower.startsWith("audio/mpeg")) {
    return ".mp3";
  }
  if (lower.startsWith("audio/wav")) {
    return ".wav";
  }
  if (lower.startsWith("video/mp4")) {
    return ".mp4";
  }
  return ".bin";
}

const TEXT_MATERIALIZATION_CONTRACT =
  "Use read or exec to process the materialized file. Do NOT base analysis on truncated transport data.";
const MEDIA_MATERIALIZATION_CONTRACT =
  "Binary file saved to disk. Report the file path and metadata to the user. Use the image tool to analyze images if applicable.";

/**
 * Save full QVeris result data to workspace: fetch, classify, write file, build manifest.
 * Never throws — returns MaterializedContentFailed on any error.
 */
async function saveQverisFullResult(params: {
  url: string;
  executionId: string;
  workspaceDir: string;
  maxBytes: number;
  timeoutSeconds: number;
  allowedDomains: string[];
}): Promise<MaterializedContent> {
  let downloaded: DownloadResult;
  try {
    downloaded = await fetchQverisResultData({
      url: params.url,
      maxBytes: params.maxBytes,
      timeoutSeconds: params.timeoutSeconds,
      allowedDomains: params.allowedDomains,
    });
  } catch (err) {
    const isTimeout =
      (err instanceof DOMException && err.name === "AbortError") ||
      (err instanceof Error && err.name === "AbortError");
    return {
      status: "failed",
      reason: isTimeout ? "download_timeout" : "download_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Determine MIME from HTTP Content-Type header (no binary magic-byte sniffing)
  let mimeType: string | undefined = downloaded.headerMime
    ? downloaded.headerMime.split(";")[0].trim()
    : undefined;

  // Heuristic: if MIME is unknown/octet-stream but text looks like JSON, reclassify
  if ((!mimeType || mimeType === "application/octet-stream") && downloaded.text) {
    const trimmed = downloaded.text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(downloaded.text);
        mimeType = "application/json";
      } catch {
        mimeType = mimeType || "application/octet-stream";
      }
    }
  }

  const category = classifyContentCategory(mimeType);

  // If the download was truncated by the byte limit, the file is incomplete.
  if (downloaded.truncatedOnDownload) {
    return {
      status: "failed",
      reason: "download_truncated",
      detail:
        `Downloaded content was truncated at ${downloaded.bytesRead} bytes (limit: ${params.maxBytes}). ` +
        "The file is incomplete. Use web_fetch for text content, exec+curl for binary content, or increase fullContentMaxBytes.",
    };
  }

  // Use raw bytes directly — preserves binary content byte-for-byte
  const buffer = Buffer.from(downloaded.raw);
  const ext = resolveExtensionForMime(mimeType);

  // Safe execution_id for directory name
  const safeDirName = params.executionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const relDir = path.posix.join(".openclaw", QVERIS_DATA_DIR_NAME, safeDirName);
  const absDir = path.join(params.workspaceDir, ".openclaw", QVERIS_DATA_DIR_NAME, safeDirName);
  const dataFilename = `data${ext}`;
  const relDataPath = path.posix.join(relDir, dataFilename);
  const absDataPath = path.join(absDir, dataFilename);

  try {
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(absDataPath, buffer, { flag: "w" });
  } catch (err) {
    return {
      status: "failed",
      reason: "write_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // Build content analysis for text-based formats (binary files get metadata only)
  const isTextBased = category === "json" || category === "csv" || category === "text";
  const { analysis, preview } =
    isTextBased && downloaded.text
      ? buildContentAnalysis(downloaded.text, category, MATERIALIZED_PREVIEW_MAX_CHARS)
      : { analysis: undefined, preview: undefined };

  // Write manifest.json for debugging/inspection
  const manifest: MaterializedContentReady = {
    status: "ready",
    path: relDataPath,
    content_category: category,
    mime_type: mimeType || "application/octet-stream",
    file_bytes: buffer.byteLength,
    ...(analysis ? { analysis } : {}),
    ...(preview ? { preview } : {}),
    consumption_contract: isTextBased
      ? TEXT_MATERIALIZATION_CONTRACT
      : MEDIA_MATERIALIZATION_CONTRACT,
  };

  try {
    await fs.writeFile(
      path.join(absDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "w" },
    );
  } catch {
    // Non-fatal: manifest.json is for debugging only
  }

  return manifest;
}

// ============================================================================
// Tool Schemas
// ============================================================================

const QverisDiscoverSchema = Type.Object({
  query: Type.String({
    description:
      "English API capability description. Describe the type of tool, not your task or question. " +
      "GOOD: 'stock quote real-time API', 'stock historical price time series API', 'web page content extraction API'. " +
      "BAD: 'what is the weather in Beijing' (question), 'AAPL stock price today' (task). " +
      "Chinese input should also produce English capability: '腾讯最新股价' -> 'stock quote real-time API'.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (1-100). Default: 10.",
      minimum: 1,
      maximum: 100,
    }),
  ),
});

const QverisCallSchema = Type.Object({
  tool_id: Type.String({
    description: "The tool_id from qveris_discover or qveris_inspect results.",
  }),
  params_to_tool: Type.String({
    description:
      "JSON dictionary of parameters to pass to the tool. " +
      "IMPORTANT: Use sample_parameters from the qveris_discover results as your template. " +
      "Common mistakes to avoid: " +
      '(1) numbers must be unquoted (limit: 10, not "10"); ' +
      "(2) dates must be ISO 8601 (2025-01-15, not 01/15/2025); " +
      '(3) use identifiers not natural language (symbol: "AAPL", not "Apple stock price"); ' +
      "(4) never omit required params listed in the discovery results. " +
      'Example: \'{"city": "London", "units": "metric"}\'.',
  }),
  max_response_size: Type.Optional(
    Type.Number({
      description:
        "Maximum size of response data in bytes. If tool generates data longer than this, it will be truncated. Default: 20480 (20KB).",
    }),
  ),
  timeout_seconds: Type.Optional(
    Type.Number({
      description:
        "Override timeout in seconds for this invocation. Short tasks (data queries): default 10s. Long tasks (image/video generation, multimodal processing): set 60-120s. Default: 60.",
      minimum: 1,
      maximum: 300,
    }),
  ),
});

const QverisInspectSchema = Type.Object({
  tool_ids: Type.String({
    description:
      "Comma-separated list of QVeris tool IDs to inspect (e.g. 'jina_ai.reader.execute.v1.b2ef8fda,openweathermap.weather.execute.v1'). " +
      "Use tool IDs from a previous qveris_discover or from session context to verify availability and get current parameter schemas.",
  }),
});

// ============================================================================
// Tool Creation
// ============================================================================

export function createQverisTools(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  agentSessionKey?: string;
  workspaceDir?: string;
}): AnyAgentTool[] {
  const config = resolveQverisConfig(options?.config);

  if (!resolveQverisEnabled({ config, sandboxed: options?.sandboxed })) {
    return [];
  }

  const apiKey = resolveQverisApiKey(config);
  if (!apiKey) {
    return [];
  }

  const baseUrl = resolveQverisBaseUrl(config);
  const discoverTimeoutSeconds = resolveDiscoverTimeoutSeconds(config);
  const callTimeoutSeconds = resolveCallTimeoutSeconds(config);
  const maxResponseSize = resolveMaxResponseSize(config);
  const discoverLimit = resolveDiscoverLimit(config);
  const autoMaterialize = resolveAutoMaterialize(config);
  const fullContentMaxBytes = resolveFullContentMaxBytes(config);
  const fullContentTimeoutSeconds = resolveFullContentTimeoutSeconds(config);
  const workspaceDir = options?.workspaceDir?.trim() || undefined;

  const discoverCache = makeDiscoverCache();
  const rolodex = makeToolRolodex();
  const discoverTracker = makeDiscoverResultTracker();

  // Per-tool invoke failure counter for progressive recovery hints
  const callFailureCount = new Map<string, number>();

  const sessionId = options?.agentSessionKey ?? `clawdbot-${Date.now()}-${randomUUID()}`;

  // Auto-resolve the backend search_id so the model never has to manage it.
  function resolveKnownSearchId(toolId: string): string | undefined {
    return rolodex.lookup(toolId)?.discoveryId ?? discoverTracker.getMeta(toolId)?.searchId;
  }

  function formatToolForModel(tool: QverisDiscoverResultTool) {
    const entry = rolodex.lookup(tool.tool_id);
    return {
      tool_id: tool.tool_id,
      name: tool.name,
      description: tool.description,
      provider_description: tool.provider_description,
      params: tool.params?.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required,
        description: p.description?.en ?? Object.values(p.description ?? {})[0],
      })),
      examples: tool.examples?.sample_parameters
        ? { sample_parameters: tool.examples.sample_parameters }
        : undefined,
      stats: tool.stats,
      ...(entry ? { previously_used: true, session_uses: entry.successCount } : {}),
    };
  }

  const discoverTool: AnyAgentTool = {
    label: "QVeris Discover",
    name: "qveris_discover",
    description:
      "Find specialized API tools for exact current values, historical sequence data, structured reports, " +
      "web extraction/crawling, PDF workflows, or external service capabilities " +
      "(OCR, speech, image/video understanding or generation, translation, geocoding). " +
      "Preferred over web_search when a specialized provider can return the answer or perform the work directly. " +
      "NOT for: local file operations, software documentation. " +
      "Query must describe the API capability in English.",
    parameters: QverisDiscoverSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? discoverLimit;
      const normalizedLimit = Math.min(Math.max(1, limit), 100);

      const cacheKey = `${query}:${normalizedLimit}`;
      const cached = discoverCache.read(cacheKey);
      if (cached) {
        return { ...cached, cached: true } as ReturnType<typeof jsonResult>;
      }

      let result: QverisDiscoverResponse;
      try {
        result = await qverisDiscover({
          query,
          sessionId,
          limit: normalizedLimit,
          apiKey,
          baseUrl,
          timeoutSeconds: discoverTimeoutSeconds,
        });
      } catch (err) {
        return jsonResult(classifyQverisError(err));
      }

      discoverTracker.trackResults(
        query,
        result.results.map((t) => ({
          tool_id: t.tool_id,
          name: t.name,
          description: t.description,
        })),
        result.search_id,
      );

      const knownTools = rolodex.getSummary();
      const payload = jsonResult({
        query: result.query,
        total: result.total,
        elapsed_time_ms: result.elapsed_time_ms,
        results: result.results.map(formatToolForModel),
        ...(knownTools.length > 0 ? { session_known_tools: knownTools } : {}),
      });

      discoverCache.write(cacheKey, payload, DEFAULT_DISCOVER_CACHE_TTL_MS);
      return payload;
    },
  };

  const callTool: AnyAgentTool = {
    label: "QVeris Call",
    name: "qveris_call",
    description:
      "Call a discovered third-party API/service. " +
      "Provide the tool_id from qveris_discover results and parameters as a JSON string in params_to_tool.",
    parameters: QverisCallSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const toolId = readStringParam(params, "tool_id", { required: true });
      const searchId = resolveKnownSearchId(toolId);
      const paramsToToolRaw = readStringParam(params, "params_to_tool", { required: true });
      const maxSize =
        readNumberParam(params, "max_response_size", { integer: true }) ?? maxResponseSize;
      const timeoutOverride = readNumberParam(params, "timeout_seconds");

      let toolParams: Record<string, unknown>;
      try {
        toolParams = JSON.parse(paramsToToolRaw) as Record<string, unknown>;
      } catch (parseError) {
        return jsonResult({
          success: false,
          error_type: "json_parse_error",
          detail: `Invalid JSON in params_to_tool: ${parseError instanceof Error ? parseError.message : "Unknown parse error"}`,
          retry_hint:
            "Use sample_parameters from the qveris_discover result as a template and ensure valid JSON.",
          note: QVERIS_WORKFLOW_NOTE,
        } satisfies QverisErrorResult);
      }

      let result: QverisInvocationResponse;
      try {
        result = await qverisCall({
          toolId,
          searchId,
          sessionId,
          parameters: toolParams,
          maxResponseSize: maxSize,
          apiKey,
          baseUrl,
          timeoutSeconds: timeoutOverride ?? callTimeoutSeconds,
        });
      } catch (err) {
        const failCount = (callFailureCount.get(toolId) ?? 0) + 1;
        callFailureCount.set(toolId, failCount);
        const recoveryStep =
          failCount === 1 ? "fix_params" : failCount === 2 ? "simplify" : "switch_tool";
        const classified = classifyQverisError(err);
        return jsonResult({
          ...classified,
          recovery_step: recoveryStep,
          attempt_number: failCount,
        });
      }

      if (result.success) {
        callFailureCount.delete(toolId);
        const meta = discoverTracker.getMeta(toolId);
        if (meta) {
          rolodex.record(toolId, {
            name: meta.name,
            description: meta.description,
            discoveryQuery: meta.query,
            discoveryId: searchId,
          });
        }
      } else {
        // Track failures reported by the QVeris backend (success: false in response body)
        const failCount = (callFailureCount.get(toolId) ?? 0) + 1;
        callFailureCount.set(toolId, failCount);
        const recoveryStep =
          failCount === 1 ? "fix_params" : failCount === 2 ? "simplify" : "switch_tool";
        return jsonResult({
          execution_id: result.execution_id,
          success: false,
          elapsed_time_ms: result.elapsed_time_ms,
          error_message: result.error_message,
          cost: result.cost ?? result.credits_used,
          recovery_step: recoveryStep,
          attempt_number: failCount,
          note: QVERIS_WORKFLOW_NOTE,
        });
      }

      const resultData = result.result;
      const fullContentUrl =
        typeof resultData?.full_content_file_url === "string" && resultData.full_content_file_url
          ? resultData.full_content_file_url
          : null;
      const isTruncated = Boolean(resultData?.truncated_content || fullContentUrl);

      // Attempt auto-materialization when full content URL is available
      if (isTruncated && fullContentUrl && autoMaterialize && workspaceDir) {
        const materialized = await saveQverisFullResult({
          url: fullContentUrl,
          executionId: result.execution_id,
          workspaceDir,
          maxBytes: fullContentMaxBytes,
          timeoutSeconds: fullContentTimeoutSeconds,
          allowedDomains: resolveFullContentAllowedDomains(config),
        });

        if (materialized.status === "ready") {
          // Strip transport-layer truncation fields so the model cannot misuse them
          const {
            truncated_content: _tc,
            full_content_file_url: _url,
            ...cleanResult
          } = resultData as Record<string, unknown>;
          return jsonResult({
            execution_id: result.execution_id,
            success: true,
            elapsed_time_ms: result.elapsed_time_ms,
            result: cleanResult,
            cost: result.cost ?? result.credits_used,
            materialized_content: materialized,
          });
        }

        // Materialization failed — degrade to current behavior with failure info
        return jsonResult({
          execution_id: result.execution_id,
          success: true,
          elapsed_time_ms: result.elapsed_time_ms,
          result: resultData,
          cost: result.cost ?? result.credits_used,
          truncated: true,
          truncation_hint:
            "Auto-materialization failed. Use web_fetch on full_content_file_url to download manually.",
          materialized_content: materialized,
        });
      }

      return jsonResult({
        execution_id: result.execution_id,
        success: true,
        elapsed_time_ms: result.elapsed_time_ms,
        result: resultData,
        cost: result.cost ?? result.credits_used,
        ...(isTruncated
          ? {
              truncated: true,
              truncation_hint:
                "Response was truncated. Increase max_response_size for full data, " +
                "or use full_content_file_url if available.",
            }
          : {}),
      });
    },
  };

  const inspectTool: AnyAgentTool = {
    label: "QVeris Inspect",
    name: "qveris_inspect",
    description:
      "Inspect known QVeris tools by their IDs without a full discovery. " +
      "Use when you already have a tool_id from a previous qveris_discover or session context " +
      "and want to verify availability and get current parameter schemas before reusing the tool.",
    parameters: QverisInspectSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const toolIdsRaw = readStringParam(params, "tool_ids", { required: true });
      const toolIds = toolIdsRaw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      if (toolIds.length === 0) {
        return jsonResult({
          success: false,
          error_type: "json_parse_error" as const,
          detail: "No valid tool IDs provided. Pass comma-separated tool IDs.",
          retry_hint: "Example: 'jina_ai.reader.execute.v1.b2ef8fda'",
          note: QVERIS_WORKFLOW_NOTE,
        } satisfies QverisErrorResult);
      }

      let result: QverisGetByIdsResponse;
      try {
        result = await qverisGetByIds({
          toolIds,
          sessionId,
          apiKey,
          baseUrl,
          timeoutSeconds: discoverTimeoutSeconds,
        });
      } catch (err) {
        return jsonResult(classifyQverisError(err));
      }

      discoverTracker.trackResults(
        "(inspect)",
        result.tools.map((t) => ({
          tool_id: t.tool_id,
          name: t.name,
          description: t.description,
        })),
      );

      const tools = result.tools.map(formatToolForModel);
      const hasSessionContext = tools.some(
        (t) => resolveKnownSearchId((t as { tool_id: string }).tool_id) !== undefined,
      );

      return jsonResult({
        tool_ids_requested: toolIds,
        tools_found: result.tools.length,
        tools,
        ...(!hasSessionContext
          ? {
              call_hint:
                "These tools have not been discovered in this session yet. " +
                "Run qveris_discover first before calling them with qveris_call.",
            }
          : {}),
      });
    },
  };

  return [discoverTool, callTool, inspectTool];
}

/**
 * Check if QVeris tools are enabled/available
 */
export function isQverisEnabled(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
}): boolean {
  const config = resolveQverisConfig(options?.config);
  return (
    resolveQverisEnabled({ config, sandboxed: options?.sandboxed }) &&
    Boolean(resolveQverisApiKey(config))
  );
}
