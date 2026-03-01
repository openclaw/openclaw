// OpenAI header-based rate limit shaping (inert unless OPENAI_SHAPING=1)
// Parses x-ratelimit-remaining-* and x-ratelimit-reset-* and Retry-After to preemptively delay
// outbound fetches to api.openai.com (and compatible hosts) before hitting 429s.

const ENABLED = (process.env.OPENAI_SHAPING || "").trim() === "1";

function isTarget(url: string): boolean {
  try {
    const u = new URL(url, "http://dummy");
    // Match OpenAI default and allow opt-in via env OPENAI_BASE_URL
    const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const host = new URL(base).host;
    return u.host === host;
  } catch {
    return false;
  }
}

function parseIntSafe(v: string | null): number | undefined {
  if (!v) {
    return undefined;
  }
  const n = parseInt(v.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}
function parseFloatSafe(v: string | null): number | undefined {
  if (!v) {
    return undefined;
  }
  const n = parseFloat(v.trim());
  return Number.isFinite(n) ? n : undefined;
}

export function installOpenAiRateLimitShaper(): void {
  if (!ENABLED) {
    return;
  }

  // Only install once
  const SHAPER_FLAG = "__ocOpenAIShaperApplied" as const;
  const g = globalThis as Record<string, unknown>;
  if (g[SHAPER_FLAG]) {
    return;
  }
  g[SHAPER_FLAG] = true;

  const buckets = new Map<string, { nextOkAt?: number; coolingUntil?: number }>();
  const jitter = (ms: number) => Math.max(0, Math.floor(ms * (0.9 + Math.random() * 0.2)));
  const now = () => Date.now();

  const origFetch: typeof fetch | undefined = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (!origFetch) {
    return;
  }

  function requestInfoToUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.toString();
    }
    // Request is available in Node 18+/undici and browsers
    if (typeof Request !== "undefined" && input instanceof Request) {
      return input.url;
    }
    // Last resort (should be rare)
    try {
      return "[object RequestInfo]";
    } catch {
      return "[object RequestInfo]";
    }
  }

  const shapedFetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = requestInfoToUrl(input);
    const key = `openai:${url}`;

    if (isTarget(url)) {
      const b = buckets.get(key) || {};
      const t = now();
      let waitMs = 0;
      if (b.coolingUntil && t < b.coolingUntil) {
        waitMs = Math.max(waitMs, b.coolingUntil - t);
      }
      if (b.nextOkAt && t < b.nextOkAt) {
        waitMs = Math.max(waitMs, b.nextOkAt - t);
      }
      if (waitMs > 0) {
        await new Promise((r) => setTimeout(r, jitter(waitMs)));
      }

      const resp = await origFetch(input, init);
      try {
        const h = resp.headers;
        const remReq = parseIntSafe(h.get("x-ratelimit-remaining-requests"));
        const limReq = parseIntSafe(h.get("x-ratelimit-limit-requests"));
        const remTok = parseIntSafe(h.get("x-ratelimit-remaining-tokens"));
        const limTok = parseIntSafe(h.get("x-ratelimit-limit-tokens"));
        const resetReqS = parseFloatSafe(h.get("x-ratelimit-reset-requests"));
        const resetTokS = parseFloatSafe(h.get("x-ratelimit-reset-tokens"));
        const retryAfterS = parseFloatSafe(h.get("retry-after"));
        const nowMs = now();
        let nextOkAt = b.nextOkAt || 0;
        if (retryAfterS && retryAfterS > 0) {
          b.coolingUntil = nowMs + Math.ceil(retryAfterS * 1000);
          nextOkAt = Math.max(nextOkAt, b.coolingUntil);
        }
        if (limReq && remReq != null && resetReqS != null && limReq > 0) {
          const frac = remReq / limReq;
          if (frac <= 0.1) {
            nextOkAt = Math.max(nextOkAt, nowMs + Math.ceil(resetReqS * 1000 * (1 - frac)));
          }
        }
        if (limTok && remTok != null && resetTokS != null && limTok > 0) {
          const frac = remTok / limTok;
          if (frac <= 0.1) {
            nextOkAt = Math.max(nextOkAt, nowMs + Math.ceil(resetTokS * 1000 * (1 - frac)));
          }
        }
        b.nextOkAt = nextOkAt > nowMs ? nextOkAt : undefined;
        buckets.set(key, b);
      } catch {
        // Ignore header parsing issues
      }

      if (resp.status === 429) {
        const ra = parseFloatSafe(resp.headers.get("retry-after")) || 2;
        const b2 = buckets.get(key) || {};
        b2.coolingUntil = now() + Math.ceil(ra * 1000);
        b2.nextOkAt = Math.max(b2.nextOkAt || 0, b2.coolingUntil);
        buckets.set(key, b2);
      }
      return resp;
    }

    return await origFetch(input, init);
  } as typeof fetch;

  globalThis.fetch = shapedFetch;
}
