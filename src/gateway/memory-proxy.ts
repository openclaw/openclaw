import { createHash } from "node:crypto";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "../config/config.js";
import { parseAgentSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
} from "./http-common.js";
import { resolveAgentIdFromModel, getHeader } from "./http-utils.js";

const GRAPHITI_PREFIX = "/graphiti";
const COGNEE_PREFIX = "/cognee";
const GRAPHITI_TARGET = "http://127.0.0.1:8100";
const COGNEE_TARGET = "http://127.0.0.1:8200";
const MAX_BODY_BYTES = 1_000_000;
const BULK_EXPORT_LIMIT = 100;
const QUERY_SPIKE_WINDOW_MS = 60_000;
const QUERY_SPIKE_THRESHOLD = 20;
const AGENT_HEADER_NAMES = [
  "x-openclaw-agent-id",
  "x-openclaw-agent",
  "agent_id",
  "agent-id",
] as const;

export const MEMORY_PROXY_CONFIGURED_AGENTS = [
  "atlas",
  "bella",
  "bosshog",
  "clara",
  "david",
  "dex",
  "gunner",
  "lucy",
  "malcolm",
  "peter",
  "quincy",
  "rook",
  "sentinel",
] as const;

export type MemoryService = "graphiti" | "cognee";
export type MemoryOperation = "read" | "write" | "delete" | "retract" | "memify";

const CASE_READERS = new Set(["rachel", "sentinel", "bosshog", "bella"]);
const DELETE_AGENTS = new Set(["rachel", "sentinel"]);
const DATASET_WRITE_ACL = new Map<string, Set<string>>([
  ["case-eea", new Set(["rachel", "sentinel"])],
  ["case-hrsp", new Set(["rachel", "sentinel"])],
  ["podcast-research", new Set(["rachel", "malcolm", "rook"])],
  ["platform-compliance", new Set(["rachel", "sentinel", "clara"])],
  ["platform-architecture", new Set(["david", "clara", "rachel"])],
]);
const MEMIFY_DISABLED_DATASETS = new Set(["case-eea", "case-hrsp"]);
const ALERT_CATEGORIES = {
  bulkExport: "bulk_export_attempt",
  querySpike: "query_spike",
  unauthorizedCaseAccess: "unauthorized_case_access",
} as const;

type QueryWindow = { hits: number[] };
const queryWindows = new Map<string, QueryWindow>();
const GENESIS_AUDIT_HASH = "GENESIS";

let auditWriteChain: Promise<void> = Promise.resolve();
let auditInitPromise: Promise<void> | null = null;
let previousAuditHash = GENESIS_AUDIT_HASH;

export function resolveMemoryProxyTarget(
  pathname: string,
): { service: MemoryService; targetBaseUrl: string; upstreamPath: string } | null {
  if (pathname === GRAPHITI_PREFIX || pathname.startsWith(`${GRAPHITI_PREFIX}/`)) {
    return {
      service: "graphiti",
      targetBaseUrl: GRAPHITI_TARGET,
      upstreamPath: pathname.slice(GRAPHITI_PREFIX.length) || "/",
    };
  }
  if (pathname === COGNEE_PREFIX || pathname.startsWith(`${COGNEE_PREFIX}/`)) {
    return {
      service: "cognee",
      targetBaseUrl: COGNEE_TARGET,
      upstreamPath: pathname.slice(COGNEE_PREFIX.length) || "/",
    };
  }
  return null;
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBodyModel(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  return trimString(record.model);
}

export function resolveTrustedMemoryAgentId(params: {
  req: IncomingMessage;
  body?: unknown;
}): string | undefined {
  const explicitSessionKey =
    trimString(getHeader(params.req, "x-openclaw-session-key")) ||
    trimString(
      new URL(params.req.url ?? "/", "http://localhost").searchParams.get("session_key"),
    ) ||
    (params.body && typeof params.body === "object"
      ? trimString((params.body as Record<string, unknown>).session_key) ||
        trimString((params.body as Record<string, unknown>).sessionKey)
      : undefined);

  if (explicitSessionKey && parseAgentSessionKey(explicitSessionKey)) {
    return resolveAgentIdFromSessionKey(explicitSessionKey);
  }

  return resolveAgentIdFromModel(readBodyModel(params.body));
}

export function resolveMemoryDataset(params: {
  service: MemoryService;
  pathname: string;
  searchParams: URLSearchParams;
  body?: unknown;
}): string | null {
  if (params.service !== "cognee") {
    return null;
  }
  const queryDataset = trimString(params.searchParams.get("dataset"));
  if (queryDataset) {
    return queryDataset;
  }
  if (!params.body || typeof params.body !== "object") {
    return null;
  }
  const record = params.body as Record<string, unknown>;
  return trimString(record.dataset) ?? null;
}

export function classifyMemoryOperation(params: {
  service: MemoryService;
  pathname: string;
  body?: unknown;
}): MemoryOperation {
  const lowered = params.pathname.toLowerCase();
  if (/\/(delete|remove)(\/|$)/.test(lowered)) {
    return "delete";
  }
  if (/\/(retract|expire)(\/|$)/.test(lowered)) {
    return "retract";
  }
  if (/\/(memify)(\/|$)/.test(lowered)) {
    return "memify";
  }
  if (params.service === "graphiti") {
    if (/\/(episodes?|add)(\/|$)/.test(lowered)) {
      return "write";
    }
    return "read";
  }
  if (/\/(add|cognify|ingest|upload|document)(\/|$)/.test(lowered)) {
    return "write";
  }
  if (params.body && typeof params.body === "object") {
    const record = params.body as Record<string, unknown>;
    if (record.content !== undefined || record.source_type !== undefined) {
      return "write";
    }
  }
  return "read";
}

export function evaluateMemoryAcl(params: {
  agentId: string;
  service: MemoryService;
  operation: MemoryOperation;
  dataset: string | null;
}): { allowed: boolean; reason?: string } {
  const agentId = params.agentId.toLowerCase();
  const dataset = params.dataset?.toLowerCase() ?? null;

  if (params.operation === "delete" || params.operation === "retract") {
    return DELETE_AGENTS.has(agentId)
      ? { allowed: true }
      : { allowed: false, reason: "delete/retract restricted to rachel and sentinel" };
  }

  if (params.service === "graphiti") {
    return { allowed: true };
  }

  if (params.operation === "memify") {
    if (dataset && MEMIFY_DISABLED_DATASETS.has(dataset)) {
      return { allowed: false, reason: `memify disabled for dataset ${dataset}` };
    }
    return { allowed: true };
  }

  if (params.operation === "read") {
    if (
      dataset &&
      (dataset === "case-eea" || dataset === "case-hrsp") &&
      !CASE_READERS.has(agentId)
    ) {
      return { allowed: false, reason: `read restricted for dataset ${dataset}` };
    }
    return { allowed: true };
  }

  if (params.operation === "write") {
    if (!dataset) {
      return { allowed: false, reason: "dataset required for cognee write operations" };
    }
    const writers = DATASET_WRITE_ACL.get(dataset);
    if (!writers) {
      return { allowed: true };
    }
    return writers.has(agentId)
      ? { allowed: true }
      : { allowed: false, reason: `write restricted for dataset ${dataset}` };
  }

  return { allowed: true };
}

function summarizeQueryText(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const first =
    trimString(record.query) ||
    trimString(record.content) ||
    trimString(record.text) ||
    trimString(record.prompt);
  return first ? first.slice(0, 500) : undefined;
}

function resolveAuditLogPath(): string {
  return `${process.env.HOME ?? "~"}/.openclaw/audit/memory-access.jsonl`;
}

async function restorePreviousAuditHashFromLog(): Promise<string> {
  try {
    const content = await readFile(resolveAuditLogPath(), "utf8");
    const lastLine = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!lastLine) {
      return GENESIS_AUDIT_HASH;
    }
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    return typeof parsed.current_hash === "string" && parsed.current_hash.trim().length > 0
      ? parsed.current_hash
      : GENESIS_AUDIT_HASH;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return GENESIS_AUDIT_HASH;
    }
    return GENESIS_AUDIT_HASH;
  }
}

export async function initializeMemoryProxyAuditState(): Promise<void> {
  if (!auditInitPromise) {
    auditInitPromise = (async () => {
      previousAuditHash = await restorePreviousAuditHashFromLog();
    })();
  }
  await auditInitPromise;
}

export function resetMemoryProxyStateForTests(): void {
  queryWindows.clear();
  auditWriteChain = Promise.resolve();
  auditInitPromise = null;
  previousAuditHash = GENESIS_AUDIT_HASH;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

async function appendAuditEntry(entry: Record<string, unknown>) {
  auditWriteChain = auditWriteChain.then(async () => {
    const auditLogPath = resolveAuditLogPath();
    await mkdir(auditLogPath.replace(/\/[^/]+$/, ""), { recursive: true });
    const previousHash =
      typeof entry.previous_hash === "string" ? entry.previous_hash : previousAuditHash;
    const payload = stableStringify({ ...entry, previous_hash: previousHash });
    const currentHash = createHash("sha256")
      .update(`${previousHash}\n${payload}`, "utf8")
      .digest("hex");
    previousAuditHash = currentHash;
    const line = `${stableStringify({ ...entry, previous_hash: previousHash, current_hash: currentHash })}\n`;
    await appendFile(auditLogPath, line, "utf8");
  });
  await auditWriteChain;
}

async function logMemoryAccess(params: {
  agentId: string;
  service: MemoryService;
  operation: MemoryOperation;
  dataset: string | null;
  status: "allow" | "deny";
  reason?: string;
  queryText?: string;
  resultCount?: number;
  path: string;
}) {
  const prev = previousAuditHash;
  await appendAuditEntry({
    record_type: "access",
    timestamp: new Date().toISOString(),
    agent_id: params.agentId,
    service: params.service,
    operation: params.operation,
    dataset: params.dataset,
    query_text: params.queryText ?? null,
    result_count: params.resultCount ?? null,
    status: params.status,
    reason: params.reason ?? null,
    path: params.path,
    previous_hash: prev,
  });
}

async function logMemoryAlert(params: {
  agentId: string;
  service: MemoryService;
  category: string;
  dataset: string | null;
  path: string;
  detail: string;
}) {
  const prev = previousAuditHash;
  await appendAuditEntry({
    record_type: "alert",
    timestamp: new Date().toISOString(),
    agent_id: params.agentId,
    service: params.service,
    category: params.category,
    dataset: params.dataset,
    path: params.path,
    detail: params.detail,
    previous_hash: prev,
  });
}

function maybeDetectBulkExport(params: {
  pathname: string;
  searchParams: URLSearchParams;
  body?: unknown;
}): string | undefined {
  const loweredPath = params.pathname.toLowerCase();
  if (/(export|dump|backup|download)/.test(loweredPath)) {
    return `path matched bulk-export pattern: ${loweredPath}`;
  }
  const limitRaw = params.searchParams.get("limit") ?? params.searchParams.get("top_k");
  const limit = limitRaw ? Number(limitRaw) : Number.NaN;
  if (Number.isFinite(limit) && limit > BULK_EXPORT_LIMIT) {
    return `requested limit ${limit} exceeds ${BULK_EXPORT_LIMIT}`;
  }
  if (params.body && typeof params.body === "object") {
    const record = params.body as Record<string, unknown>;
    const bodyLimit = Number(record.limit ?? record.top_k ?? record.max_results);
    if (Number.isFinite(bodyLimit) && bodyLimit > BULK_EXPORT_LIMIT) {
      return `requested body limit ${bodyLimit} exceeds ${BULK_EXPORT_LIMIT}`;
    }
  }
  return undefined;
}

function maybeDetectQuerySpike(
  agentId: string,
  service: MemoryService,
  operation: MemoryOperation,
): string | undefined {
  if (operation !== "read") {
    return undefined;
  }
  const now = Date.now();
  const key = `${agentId}:${service}`;
  const window = queryWindows.get(key) ?? { hits: [] };
  window.hits = window.hits.filter((ts) => now - ts <= QUERY_SPIKE_WINDOW_MS);
  window.hits.push(now);
  queryWindows.set(key, window);
  if (window.hits.length > QUERY_SPIKE_THRESHOLD) {
    return `${window.hits.length} read queries within ${QUERY_SPIKE_WINDOW_MS}ms`;
  }
  return undefined;
}

function stripCallerAgentHeaders(headers: IncomingMessage["headers"]): Headers {
  const forwardHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) {
      continue;
    }
    const lowered = name.toLowerCase();
    if (
      lowered === "host" ||
      lowered === "content-length" ||
      AGENT_HEADER_NAMES.includes(lowered as never)
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        forwardHeaders.append(name, entry);
      }
    } else {
      forwardHeaders.set(name, value);
    }
  }
  return forwardHeaders;
}

function buildForwardBody(params: {
  req: IncomingMessage;
  service: MemoryService;
  trustedAgentId: string;
  body?: unknown;
}): BodyInit | undefined {
  if (params.req.method === "GET" || params.req.method === "HEAD") {
    return undefined;
  }
  if (params.body === undefined) {
    return undefined;
  }
  if (params.body && typeof params.body === "object" && !Array.isArray(params.body)) {
    const record = { ...(params.body as Record<string, unknown>) };
    delete record.agent_id;
    delete record.agentId;
    return JSON.stringify({ ...record, agent_id: params.trustedAgentId });
  }
  return JSON.stringify(params.body);
}

function injectTrustedAgentQuery(searchParams: URLSearchParams, trustedAgentId: string): string {
  searchParams.delete("agent_id");
  searchParams.delete("agentId");
  searchParams.set("agent_id", trustedAgentId);
  const rendered = searchParams.toString();
  return rendered ? `?${rendered}` : "";
}

export async function handleMemoryProxyHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = resolveMemoryProxyTarget(url.pathname);
  if (!route) {
    return false;
  }

  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(req.method ?? "")) {
    sendMethodNotAllowed(res, "GET, POST, PUT, PATCH, DELETE, HEAD");
    return true;
  }

  const authorized = await authorizeGatewayBearerRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!authorized) {
    return true;
  }

  let body: unknown;
  if (!["GET", "HEAD"].includes(req.method ?? "")) {
    body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
    if (body === undefined) {
      return true;
    }
  }

  const trustedAgentId = resolveTrustedMemoryAgentId({ req, body });
  if (!trustedAgentId) {
    sendInvalidRequest(res, "Missing trusted agent session context for memory request.");
    return true;
  }

  const dataset = resolveMemoryDataset({
    service: route.service,
    pathname: route.upstreamPath,
    searchParams: url.searchParams,
    body,
  });
  const operation = classifyMemoryOperation({
    service: route.service,
    pathname: route.upstreamPath,
    body,
  });
  const acl = evaluateMemoryAcl({
    agentId: trustedAgentId,
    service: route.service,
    operation,
    dataset,
  });
  const queryText = summarizeQueryText(body);

  const bulkExportDetail = maybeDetectBulkExport({
    pathname: route.upstreamPath,
    searchParams: url.searchParams,
    body,
  });
  if (bulkExportDetail) {
    await logMemoryAlert({
      agentId: trustedAgentId,
      service: route.service,
      category: ALERT_CATEGORIES.bulkExport,
      dataset,
      path: route.upstreamPath,
      detail: bulkExportDetail,
    });
  }
  const querySpikeDetail = maybeDetectQuerySpike(trustedAgentId, route.service, operation);
  if (querySpikeDetail) {
    await logMemoryAlert({
      agentId: trustedAgentId,
      service: route.service,
      category: ALERT_CATEGORIES.querySpike,
      dataset,
      path: route.upstreamPath,
      detail: querySpikeDetail,
    });
  }

  if (!acl.allowed) {
    await logMemoryAccess({
      agentId: trustedAgentId,
      service: route.service,
      operation,
      dataset,
      status: "deny",
      reason: acl.reason,
      queryText,
      path: route.upstreamPath,
    });
    if (dataset && (dataset === "case-eea" || dataset === "case-hrsp")) {
      await logMemoryAlert({
        agentId: trustedAgentId,
        service: route.service,
        category: ALERT_CATEGORIES.unauthorizedCaseAccess,
        dataset,
        path: route.upstreamPath,
        detail: acl.reason ?? "unauthorized case dataset access",
      });
    }
    sendJson(res, 403, {
      ok: false,
      error: { type: "forbidden", message: acl.reason ?? "forbidden" },
    });
    return true;
  }

  const headers = stripCallerAgentHeaders(req.headers);
  headers.set("x-openclaw-agent-id", trustedAgentId);
  headers.set("x-openclaw-agent", trustedAgentId);
  if (body !== undefined) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  const upstreamUrl = `${route.targetBaseUrl}${route.upstreamPath}${injectTrustedAgentQuery(url.searchParams, trustedAgentId)}`;
  const upstreamResponse = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: buildForwardBody({ req, service: route.service, trustedAgentId, body }),
    redirect: "manual",
  });

  res.statusCode = upstreamResponse.status;
  upstreamResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === "transfer-encoding") {
      return;
    }
    res.setHeader(key, value);
  });
  const responseText = req.method === "HEAD" ? "" : await upstreamResponse.text();
  const contentType = upstreamResponse.headers.get("content-type") ?? "";
  let resultCount: number | undefined;
  if (contentType.includes("application/json") && responseText) {
    try {
      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      if (Array.isArray(parsed.results)) {
        resultCount = parsed.results.length;
      } else if (Array.isArray(parsed.data)) {
        resultCount = parsed.data.length;
      } else if (typeof parsed.count === "number") {
        resultCount = parsed.count;
      }
    } catch {
      // Ignore count extraction for non-JSON payloads.
    }
  }

  await logMemoryAccess({
    agentId: trustedAgentId,
    service: route.service,
    operation,
    dataset,
    status: "allow",
    queryText,
    resultCount,
    path: route.upstreamPath,
  });

  res.end(responseText);
  return true;
}

export function listConfiguredMemoryAgents(): string[] {
  const cfg = loadConfig();
  const configured = Array.isArray(cfg.agents?.list)
    ? cfg.agents.list
        .map((entry) =>
          String(entry?.id ?? "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean)
    : [];
  return Array.from(new Set(configured)).toSorted();
}
