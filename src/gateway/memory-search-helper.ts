import { loadConfig } from "../config/config.js";
import { resolveExplicitAgentSessionKey } from "../config/sessions/main-session.js";
import { resolveGatewayProbeAuth } from "./probe-auth.js";

export type FetchMemorySearchOptions = {
  query: string;
  agentId?: string;
  url?: string;
  timeoutMs?: number;
  maxResults?: number;
  minScore?: number;
};

type StructuredErrorCode =
  | "invalid_request"
  | "gateway_unavailable"
  | "invalid_payload"
  | "auth_failed"
  | "endpoint_unavailable";

class MemorySearchHelperError extends Error {
  declare code: StructuredErrorCode;

  constructor(message: string, code: StructuredErrorCode, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "MemorySearchHelperError";
    this.code = code;
  }
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeQuery(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new MemorySearchHelperError("memory_search query is required.", "invalid_request");
  }
  return trimmed;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function resolveInvokeUrl(url: string | undefined): { invokeUrl: string; mode: "local" | "remote" } {
  const normalizedUrl = trimToUndefined(url);
  const cfg = loadConfig();

  if (!normalizedUrl) {
    const port = cfg.gateway?.port ?? 19001;
    const secure = cfg.gateway?.tls?.enabled === true;
    return {
      invokeUrl: `${secure ? "https" : "http"}://127.0.0.1:${port}/tools/invoke`,
      mode: "local",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch (error) {
    throw new MemorySearchHelperError(
      `Invalid OpenClaw gateway URL: ${normalizedUrl}`,
      "invalid_request",
      { cause: error },
    );
  }

  const protocol =
    parsedUrl.protocol === "wss:"
      ? "https:"
      : parsedUrl.protocol === "ws:"
        ? "http:"
        : parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:"
          ? parsedUrl.protocol
          : null;

  if (!protocol) {
    throw new MemorySearchHelperError(
      `Unsupported OpenClaw gateway URL protocol: ${parsedUrl.protocol}`,
      "invalid_request",
    );
  }

  parsedUrl.protocol = protocol;
  parsedUrl.pathname = "/tools/invoke";
  parsedUrl.search = "";
  parsedUrl.hash = "";

  return {
    invokeUrl: parsedUrl.toString(),
    mode: isLoopbackHostname(parsedUrl.hostname) ? "local" : "remote",
  };
}

function resolveMemorySearchBody(options: FetchMemorySearchOptions) {
  const query = normalizeQuery(options.query);
  const params: Record<string, unknown> = { query };
  const cfg = loadConfig();

  if (typeof options.maxResults === "number" && Number.isFinite(options.maxResults)) {
    params.maxResults = Math.max(1, Math.floor(options.maxResults));
  }

  if (typeof options.minScore === "number" && Number.isFinite(options.minScore)) {
    params.minScore = options.minScore;
  }

  const sessionKey = resolveExplicitAgentSessionKey({
    cfg,
    agentId: trimToUndefined(options.agentId),
  });

  return {
    tool: "memory_search",
    args: params,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

async function parseInvokeResponse(response: Response) {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new MemorySearchHelperError(
      "OpenClaw memory search returned invalid JSON.",
      "invalid_payload",
      { cause: error },
    );
  }
}

function resolveAuthHeader(mode: "local" | "remote") {
  const cfg = loadConfig();
  const credentials = resolveGatewayProbeAuth({ cfg, mode, env: process.env });
  const credential = trimToUndefined(credentials.token) ?? trimToUndefined(credentials.password);
  return credential ? `Bearer ${credential}` : undefined;
}

function normalizeHttpError(payload: unknown, response: Response): never {
  const source =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const error =
    source.error && typeof source.error === "object" && !Array.isArray(source.error)
      ? (source.error as Record<string, unknown>)
      : {};
  const message =
    trimToUndefined(error.message) ??
    trimToUndefined(source.message) ??
    `OpenClaw memory search failed with HTTP ${response.status}.`;

  if (response.status === 401 || response.status === 403) {
    throw new MemorySearchHelperError(message, "auth_failed");
  }

  if (response.status === 404 || response.status === 405 || response.status === 501) {
    throw new MemorySearchHelperError(message, "endpoint_unavailable");
  }

  throw new MemorySearchHelperError(message, "gateway_unavailable");
}

export async function fetchMemorySearch(
  options: FetchMemorySearchOptions,
): Promise<Record<string, unknown>> {
  const { invokeUrl, mode } = resolveInvokeUrl(options.url);
  const authHeader = resolveAuthHeader(mode);
  const body = resolveMemorySearchBody(options);
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : 10_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(invokeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await parseInvokeResponse(response);

    if (!response.ok) {
      normalizeHttpError(payload, response);
    }

    const root =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    const result =
      root.result && typeof root.result === "object" && !Array.isArray(root.result)
        ? (root.result as Record<string, unknown>)
        : {};
    const details =
      result.details && typeof result.details === "object" && !Array.isArray(result.details)
        ? (result.details as Record<string, unknown>)
        : null;

    if (details) {
      return details;
    }

    if (Object.keys(result).length > 0) {
      return result;
    }

    throw new MemorySearchHelperError(
      "OpenClaw memory search payload is missing result details.",
      "invalid_payload",
    );
  } catch (error) {
    if (error instanceof MemorySearchHelperError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new MemorySearchHelperError(
        `OpenClaw memory search timed out after ${timeoutMs}ms.`,
        "gateway_unavailable",
        { cause: error },
      );
    }

    throw new MemorySearchHelperError(
      error instanceof Error ? error.message : String(error),
      "gateway_unavailable",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}
