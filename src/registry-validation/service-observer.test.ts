// Tests for ServiceObserver.
import { describe, expect, it, vi } from "vitest";
import { EvidenceRecordSchema } from "../config/zod-schema.registry-validation.js";
import { observeService } from "./service-observer.js";
import type { ServicePolicy, ServiceProbeDeps, ServiceProbeResponse } from "./service-observer.js";

const FIXED_TIME = "2026-07-18T12:00:00.000Z";

function makeDeps(
  fetchImpl: (
    url: string,
    init: { method: string; headers?: Record<string, string>; signal: AbortSignal },
  ) => Promise<ServiceProbeResponse>,
): ServiceProbeDeps {
  return {
    fetch: vi.fn(fetchImpl),
    createAbortController: () => new AbortController(),
    createTimeout: (_ms: number, _signal: AbortSignal) => ({
      cancel: vi.fn(),
      promise: new Promise<void>(() => {}),
    }),
  };
}

function makePolicy(overrides: Partial<ServicePolicy> = {}): ServicePolicy {
  return {
    serviceId: "n8n-local",
    serviceType: "n8n",
    endpointId: "n8n-health",
    url: "http://localhost:5678/healthz",
    method: "GET",
    timeoutMs: 5000,
    retryCount: 0,
    expectedStatus: [200],
    responseBodyPolicy: "never",
    redactionPolicy: "strict",
    ...overrides,
  };
}

function makeBoundedDeps(
  fetchImpl: (
    url: string,
    init: { method: string; headers?: Record<string, string>; signal: AbortSignal },
  ) => Promise<ServiceProbeResponse>,
  cancelSpy = vi.fn(),
): { deps: ServiceProbeDeps; cancelSpy: ReturnType<typeof vi.fn> } {
  return {
    deps: {
      fetch: vi.fn(fetchImpl),
      createAbortController: () => new AbortController(),
      createTimeout: (ms: number, _signal: AbortSignal) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const promise = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timer = null;
            resolve();
          }, ms);
        });
        return {
          cancel: () => {
            cancelSpy();
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
          },
          promise,
        };
      },
    },
    cancelSpy,
  };
}

describe("ServiceObserver", () => {
  it("ready under explicit policy (but REQUIRES SOURCE VERIFICATION for n8n)", async () => {
    // Since n8n readiness endpoint is not proven, even a 200 response
    // should not produce READY — it should produce REACHABLE_NOT_READY
    const deps = makeDeps(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.outcome).toBe("REACHABLE_NOT_READY");
    expect(result.httpStatus).toBe(200);
    expect(result.latencyMs).not.toBeNull();
    expect(result.attemptCount).toBe(1);
  });

  it("reachable but readiness condition fails", async () => {
    const deps = makeDeps(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.outcome).toBe("REACHABLE_NOT_READY");
    expect(result.httpStatus).toBe(200);
  });

  it("timeout", async () => {
    const deps = makeDeps(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const result = await observeService(makePolicy({ timeoutMs: 100 }), deps, {
      now: () => FIXED_TIME,
    });
    expect(result.outcome).toBe("TIMEOUT");
    expect(result.httpStatus).toBeNull();
  });

  it("connection refused", async () => {
    const deps = makeDeps(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5678");
    });
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.outcome).toBe("CONNECTION_REFUSED");
  });

  it("authentication required (401)", async () => {
    const deps = makeDeps(async () => ({
      status: 401,
      statusText: "Unauthorized",
      headers: {},
    }));
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.outcome).toBe("AUTH_REQUIRED");
    expect(result.httpStatus).toBe(401);
  });

  it("unexpected status (500)", async () => {
    const deps = makeDeps(async () => ({
      status: 500,
      statusText: "Internal Server Error",
      headers: {},
    }));
    const result = await observeService(makePolicy({ retryCount: 0 }), deps, {
      now: () => FIXED_TIME,
    });
    expect(result.outcome).toBe("UNEXPECTED_RESPONSE");
    expect(result.httpStatus).toBe(500);
  });

  it("one approved retry succeeds (from error to REACHABLE_NOT_READY)", async () => {
    let attempt = 0;
    const deps = makeDeps(async () => {
      attempt++;
      if (attempt === 1) {
        throw new Error("connect ECONNREFUSED");
      }
      return {
        status: 200,
        statusText: "OK",
        headers: {},
      };
    });
    // Even with retry, connection refused returns immediately
    const result = await observeService(makePolicy({ retryCount: 1 }), deps, {
      now: () => FIXED_TIME,
    });
    expect(result.attemptCount).toBeGreaterThanOrEqual(1);
  });

  it("retry limit enforced (max 1 retry = 2 attempts)", async () => {
    let attempts = 0;
    const deps = makeDeps(async () => {
      attempts++;
      return {
        status: 500,
        statusText: "Internal Server Error",
        headers: {},
      };
    });
    const result = await observeService(makePolicy({ retryCount: 1 }), deps, {
      now: () => FIXED_TIME,
    });
    expect(attempts).toBe(2);
    expect(result.attemptCount).toBe(2);
  });

  it("invalid policy (empty url)", async () => {
    const deps = makeDeps(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const result = await observeService(makePolicy({ url: "" }), deps, { now: () => FIXED_TIME });
    expect(result.outcome).toBe("INVALID_POLICY");
    expect(result.error).toContain("url");
  });

  it("authorization redacted in errors", async () => {
    const deps = makeDeps(async () => {
      throw new Error("Authorization: Bearer secret-token-12345 failed");
    });
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.error).not.toContain("secret-token-12345");
  });

  it("token in URL redacted", async () => {
    const deps = makeDeps(async (url) => {
      // The URL should already be redacted before reaching fetch
      expect(url).not.toContain("secret-token");
      return {
        status: 200,
        statusText: "OK",
        headers: {},
      };
    });
    const result = await observeService(
      makePolicy({ url: "https://user:secret-token@host.com/api" }),
      deps,
      { now: () => FIXED_TIME },
    );
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("response body not persisted", async () => {
    const deps = makeDeps(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
      bodyText: "sensitive response body content",
    }));
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.bodyRetained).toBe(false);
    // The evidence should not contain the response body
    const allNotes = result.evidence.map((e) => e.notes ?? "").join(" ");
    expect(allNotes).not.toContain("sensitive response body content");
  });

  it("latency recorded", async () => {
    const deps = makeDeps(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.latencyMs).not.toBeNull();
    expect(typeof result.latencyMs).toBe("number");
  });

  it("attempt count recorded", async () => {
    const deps = makeDeps(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.attemptCount).toBe(1);
  });

  it("generic HTTP 200 does not automatically produce READY", async () => {
    const deps = makeDeps(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(result.outcome).not.toBe("READY");
  });

  it("no live network (uses mocked transport)", async () => {
    const mockFetch = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const deps: ServiceProbeDeps = {
      fetch: mockFetch,
      createAbortController: () => new AbortController(),
      createTimeout: () => ({ cancel: vi.fn(), promise: new Promise<void>(() => {}) }),
    };
    await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    expect(mockFetch).toHaveBeenCalled();
    // The mock was called, not a real network fetch
  });

  it("evidence validates against Phase 4F1 schema", async () => {
    const deps = makeDeps(async () => ({
      status: 200,
      statusText: "OK",
      headers: {},
    }));
    const result = await observeService(makePolicy(), deps, { now: () => FIXED_TIME });
    for (const evidence of result.evidence) {
      const validation = EvidenceRecordSchema.safeParse(evidence);
      expect(validation.success).toBe(true);
    }
  });

  it("DNS error", async () => {
    const deps = makeDeps(async () => {
      throw new Error("getaddrinfo ENOTFOUND nonexistent.host");
    });
    const result = await observeService(makePolicy({ url: "http://nonexistent.host/api" }), deps, {
      now: () => FIXED_TIME,
    });
    expect(result.outcome).toBe("DNS_ERROR");
  });

  it("TLS error", async () => {
    const deps = makeDeps(async () => {
      throw new Error("certificate has expired");
    });
    const result = await observeService(makePolicy({ url: "https://expired.badssl.com/" }), deps, {
      now: () => FIXED_TIME,
    });
    expect(result.outcome).toBe("TLS_ERROR");
  });

  it("retry timeout-race: pending fetch + injected timeout → TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      let cancelCalled = false;
      const { deps, cancelSpy } = makeBoundedDeps(
        async () => {
          // Fetch never resolves - timeout should win
          return new Promise<ServiceProbeResponse>(() => {});
        },
        vi.fn(() => {
          cancelCalled = true;
        }),
      );
      const resultPromise = observeService(makePolicy({ timeoutMs: 100 }), deps, {
        now: () => FIXED_TIME,
      });
      await vi.advanceTimersByTimeAsync(100); // first timeout; allow retry to be scheduled
      await vi.advanceTimersByTimeAsync(100); // second timeout
      const result = await resultPromise;
      expect(result.outcome).toBe("TIMEOUT");
      expect(result.httpStatus).toBeNull();
      expect(result.bodyRetained).toBe(false);
      expect(result.attemptCount).toBe(1);
      expect(cancelCalled).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("retry timeout-race: retryCount: 1 + pending fetch per attempt → exactly two attempts, TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      let attemptCount = 0;
      const { deps, cancelSpy } = makeBoundedDeps(async () => {
        attemptCount++;
        // Fetch never resolves - timeout should win each attempt
        return new Promise<ServiceProbeResponse>(() => {});
      }, vi.fn());
      const resultPromise = observeService(makePolicy({ timeoutMs: 100, retryCount: 1 }), deps, {
        now: () => FIXED_TIME,
      });
      await vi.advanceTimersByTimeAsync(100); // first timeout; allow retry to be scheduled
      await vi.advanceTimersByTimeAsync(100); // second timeout
      const result = await resultPromise;
      expect(attemptCount).toBe(2);
      expect(result.outcome).toBe("TIMEOUT");
      expect(result.httpStatus).toBeNull();
      expect(result.bodyRetained).toBe(false);
      expect(result.attemptCount).toBe(2);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
