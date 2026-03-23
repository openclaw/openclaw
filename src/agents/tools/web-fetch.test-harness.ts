import { afterEach, beforeEach, vi } from "vitest";
import * as ssrf from "../../infra/net/ssrf.js";

export function installWebFetchSsrfHarness() {
  const lookupMock = vi.fn();
  const resolvePinnedHostname = ssrf.resolvePinnedHostname;
  const priorFetch = global.fetch;

  beforeEach(() => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.spyOn(ssrf, "resolvePinnedHostname").mockImplementation((hostname) =>
      resolvePinnedHostname(hostname, lookupMock),
    );
  });

  afterEach(() => {
    global.fetch = priorFetch;
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });
}

export function createBaseWebFetchToolConfig(opts?: { maxResponseBytes?: number }): {
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
  };
}
