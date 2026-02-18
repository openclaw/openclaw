import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

function isEnabled(): boolean {
  const v = process.env.OPENCLAW_HTTP_EGRESS_AUDIT;
  return v === "1" || v === "true" || v === "yes";
}

function auditDir(): string | null {
  const value = process.env.OPENCLAW_HTTP_EGRESS_AUDIT_DIR?.trim();
  return value && value.length > 0 ? value : null;
}

function sanitizeHostForPath(host: string): string {
  const h = host.toLowerCase().trim();
  // Keep it simple and filesystem-safe.
  return h.replace(/[^a-z0-9.-]+/g, "_");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return JSON.stringify({ _unserializable: true, error: String(e) });
  }
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function headersToObject(h: Headers | Record<string, string> | undefined): Record<string, string> {
  if (!h) {
    return {};
  }
  if (h instanceof Headers) {
    const out: Record<string, string> = {};
    h.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  // Handle array format [string, string][] from HeadersInit
  if (Array.isArray(h)) {
    const out: Record<string, string> = {};
    for (const [key, value] of h) {
      out[key] = value;
    }
    return out;
  }
  return { ...h };
}

// Sensitive headers that should be redacted
const SENSITIVE_HEADERS = ["authorization", "x-api-key", "api-key", "x-auth-token", "cookie"];

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADERS.some((sk) => lowerKey.includes(sk))) {
      // Keep first 4 chars, mask middle with ****, keep last 4 chars (or [REDACTED] if too short)
      if (value.length > 8) {
        result[key] = `${value.slice(0, 4)}****${value.slice(-4)}`;
      } else {
        result[key] = "[REDACTED]";
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function nowMs(): number {
  return Date.now();
}

function resolveAuditPaths(url: string): { reqFile: string; resFile: string } | null {
  const dir = auditDir();
  if (!dir) {
    return null;
  }

  let host = "unknown-host";
  try {
    host = sanitizeHostForPath(new URL(url).host || host);
  } catch {
    // ignore
  }

  return {
    reqFile: `${dir}/${host}/${today()}-requests.jsonl`,
    resFile: `${dir}/${host}/${today()}-responses.jsonl`,
  };
}

async function ensureDir(p: string) {
  await mkdir(p, { recursive: true });
}

async function appendJsonl(filePath: string, line: string) {
  await ensureDir(dirname(filePath));
  const fh = await open(filePath, "a");
  try {
    await fh.appendFile(line + "\n", "utf8");
  } finally {
    await fh.close();
  }
}

const wrapFetchWithEgressAuditMarker = Symbol("wrapFetchWithEgressAudit");

export function isFetchWrappedWithEgressAudit(fetchImpl: typeof fetch): boolean {
  return (
    typeof fetchImpl === "function" &&
    (fetchImpl as { [wrapFetchWithEgressAuditMarker]?: boolean })[
      wrapFetchWithEgressAuditMarker
    ] === true
  );
}

export function wrapFetchWithEgressAudit(fetchImpl: typeof fetch): typeof fetch {
  if (!isEnabled() || isFetchWrappedWithEgressAudit(fetchImpl)) {
    return fetchImpl;
  }

  const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = nowMs();

    const req = input instanceof Request ? input : undefined;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (req?.url ?? "");
    const method = init?.method ?? req?.method ?? "GET";

    const requestHeaders: Record<string, string> = {
      ...headersToObject(req?.headers),
      ...headersToObject(init?.headers as Record<string, string> | Headers | undefined),
    };

    // Note: reading Request body is not safe (stream gets consumed). We only log init.body when it's a string.
    let bodyText: string | undefined;
    if (typeof init?.body === "string") {
      bodyText = init.body;
    }

    const id = sha256Hex(
      `${startedAt}:${method}:${url}:${safeJson(requestHeaders)}:${bodyText ?? ""}`,
    );
    const paths = resolveAuditPaths(url);

    if (paths) {
      void appendJsonl(
        paths.reqFile,
        safeJson({
          t: "request",
          id,
          ts: startedAt,
          url,
          method,
          headers: redactHeaders(requestHeaders),
          body: bodyText,
        }),
      ).catch(() => undefined);
    }

    try {
      const res = await fetchImpl(input as unknown as RequestInfo, init as unknown as RequestInit);

      if (paths) {
        const cloned = res.clone();
        const status = cloned.status;
        const statusText = cloned.statusText;
        const responseHeaders = headersToObject(cloned.headers);
        void (async () => {
          let responseBody: string | undefined;
          try {
            // This will buffer the full response. Good for audit, but can be big.
            responseBody = await cloned.text();
          } catch (e) {
            responseBody = `[unreadable body: ${String(e)}]`;
          }

          await appendJsonl(
            paths.resFile,
            safeJson({
              t: "response",
              id,
              ts: nowMs(),
              ms: nowMs() - startedAt,
              url,
              status,
              statusText,
              headers: redactHeaders(responseHeaders),
              body: responseBody,
            }),
          );
        })().catch(() => undefined);
      }

      return res;
    } catch (e) {
      if (paths) {
        void appendJsonl(
          paths.resFile,
          safeJson({
            t: "error",
            id,
            ts: nowMs(),
            ms: nowMs() - startedAt,
            url,
            error: String(e),
          }),
        ).catch(() => undefined);
      }
      throw e;
    }
  }) as typeof fetch;

  Object.defineProperty(wrappedFetch, wrapFetchWithEgressAuditMarker, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  return wrappedFetch;
}
