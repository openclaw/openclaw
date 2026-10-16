import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  LiveModelCatalogHttpError,
  runLiveProviderCatalog,
} from "./provider-catalog-live-outcome.internal.js";
import { fetchWithSsrFGuard } from "./ssrf-runtime.js";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn,
    }),
  };
});

describe("live provider catalog failure diagnostics", () => {
  beforeEach(() => warn.mockClear());
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      error: new LiveModelCatalogHttpError("fixture", 404),
      reason: "http",
      status: "unavailable",
      httpStatus: 404,
    },
    {
      error: new LiveModelCatalogHttpError("fixture", 401),
      reason: "http",
      status: "auth-rejected",
      httpStatus: 401,
    },
    {
      error: new LiveModelCatalogHttpError("fixture", 403),
      reason: "http",
      status: "auth-rejected",
      httpStatus: 403,
    },
    {
      error: new DOMException("synthetic-private-body", "TimeoutError"),
      reason: "timeout",
      status: "unavailable",
    },
    {
      error: new DOMException("synthetic-private-body", "AbortError"),
      reason: "aborted",
      status: "unavailable",
    },
    {
      error: new Error("https://user:synthetic-secret@example.test?token=synthetic-token"),
      reason: "unknown",
      status: "unavailable",
    },
    {
      error: { message: "synthetic-private-body", token: "synthetic-token" },
      reason: "unknown",
      status: "unavailable",
    },
  ])(
    "records safe $reason diagnostics while retaining $status",
    async ({ error, reason, status, httpStatus }) => {
      const result = await runLiveProviderCatalog({
        providerId: "fixture",
        profileId: "synthetic-private-profile",
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Provider callbacks may reject with non-Error values; verify those values cannot leak diagnostics.
        run: () => Promise.reject(error),
      });
      expect(result).toEqual({
        providers: {},
        outcomes: [
          {
            provider: "fixture",
            profileId: "synthetic-private-profile",
            status,
            ...(status === "auth-rejected" ? { rejectionScope: "catalog" } : {}),
          },
        ],
      });
      expect(warn).toHaveBeenCalledOnce();
      const call = warn.mock.calls[0];
      if (!call) {
        throw new Error("Expected the catalog failure warning");
      }
      const [message, metadata] = call;
      expect(message).toBe("Provider catalog discovery failed; skipping unavailable catalog");
      expect(metadata).toEqual({
        provider: "fixture",
        phase: "live-catalog",
        reason,
        elapsedMs: expect.any(Number),
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /synthetic-private|synthetic-secret|synthetic-token|example\.test/,
      );
    },
  );

  it("accepts successful awaited catalog work without emitting a failure", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(4500);
    const result = await runLiveProviderCatalog({
      providerId: "fixture",
      run: async () => {
        await Promise.resolve();
        return { providers: {} };
      },
    });
    expect(result).toEqual({ providers: {}, outcomes: [{ provider: "fixture", status: "ready" }] });
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps an exception with a throwing name accessor unavailable", async () => {
    const error = new Error("synthetic-private-body");
    Object.defineProperty(error, "name", {
      get: () => {
        throw new Error("synthetic-token");
      },
    });
    expect(
      await runLiveProviderCatalog({
        providerId: "fixture",
        run: async () => {
          throw error;
        },
      }),
    ).toEqual({ providers: {}, outcomes: [{ provider: "fixture", status: "unavailable" }] });
    const call = warn.mock.calls[0];
    if (!call) {
      throw new Error("Expected the catalog failure warning");
    }
    expect(call[1]).toMatchObject({ reason: "unknown" });
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/synthetic-private|synthetic-token/);
  });

  it("classifies the actual guarded-fetch DNS deadline without dispatching", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn();
    const lookupStarted = createDeferredCore();
    try {
      const result = runLiveProviderCatalog({
        providerId: "fixture",
        run: async () => {
          await fetchWithSsrFGuard({
            url: "https://provider.example.test/v1/models",
            timeoutMs: 1,
            fetchImpl,
            lookupFn: () => {
              lookupStarted.resolve();
              return new Promise(() => {});
            },
          });
          return { providers: {} };
        },
      });
      await lookupStarted.promise;
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({
        providers: {},
        outcomes: [{ provider: "fixture", status: "unavailable" }],
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "Provider catalog discovery failed; skipping unavailable catalog",
        expect.objectContaining({ reason: "timeout", phase: "live-catalog" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
