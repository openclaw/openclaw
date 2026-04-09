import type { LookupFn } from "../../infra/net/ssrf.js";

export function makeFetchHeaders(map: Record<string, string>): {
  get: (key: string) => string | null;
} {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

export function createBaseWebFetchToolConfig(opts?: {
  maxResponseBytes?: number;
  lookupFn?: LookupFn;
}): {
  config: {
    tools: {
      web: {
        fetch: {
          cacheTtlMinutes: number;
          firecrawl: { enabled: boolean };
          maxResponseBytes?: number;
        };
      };
    };
  };
  lookupFn?: LookupFn;
} {
  return {
    config: {
      tools: {
        web: {
          fetch: {
            cacheTtlMinutes: 0,
            firecrawl: { enabled: false },
            ...(opts?.maxResponseBytes ? { maxResponseBytes: opts.maxResponseBytes } : {}),
          },
        },
      },
    },
    ...(opts?.lookupFn ? { lookupFn: opts.lookupFn } : {}),
  };
}
