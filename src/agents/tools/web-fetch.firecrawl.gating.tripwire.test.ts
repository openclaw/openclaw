/**
 * Regression Test: fetchFirecrawlContent Network Gating
 *
 * Validates that the bare fetch() call in fetchFirecrawlContent has been
 * properly replaced with fetchWithWebToolsNetworkGuard, ensuring:
 * - ClarityBurstAbstainError propagates fail-closed before any network I/O
 * - Identical request semantics (method, headers, body, signal)
 * - Identical response handling (res.ok, res.status, res.json())
 * - Identical error behavior
 * - Proper cleanup via release() in finally block
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GuardedFetchResult } from "../../infra/net/fetch-guard.js";
import { ClarityBurstAbstainError } from "../../clarityburst/errors.js";
import * as webFetchModule from "./web-fetch.js";
import * as webGuardedFetchModule from "./web-guarded-fetch.js";

describe("fetchFirecrawlContent network gating (web-fetch.firecrawl.gating)", () => {
  let fetchWithWebToolsNetworkGuardSpy: ReturnType<typeof vi.spyOn>;
  let mockRelease: () => Promise<void>;
  let mockResponse: Partial<Response>;

  beforeEach(() => {
    // Clear previous spy
    if (fetchWithWebToolsNetworkGuardSpy) {
      vi.restoreAllMocks();
    }
    
    mockRelease = vi.fn(async () => {});
    mockResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        success: true,
        data: {
          markdown: "# Test Content",
          metadata: {
            title: "Test Title",
            sourceURL: "https://example.com",
            statusCode: 200,
          },
        },
      }),
    };

    fetchWithWebToolsNetworkGuardSpy = vi.spyOn(webGuardedFetchModule, "fetchWithWebToolsNetworkGuard");
  });

  describe("abstain error: fail-closed before network I/O", () => {
    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │ TRIPWIRE: ClarityBurstAbstainError must be raised BEFORE any network I/O   │
     * │                                                                            │
     * │ If abstain error occurs, the gated wrapper should:                        │
     * │ 1. Check NETWORK_IO permissions FIRST                                    │
     * │ 2. Raise ClarityBurstAbstainError if denied                              │
     * │ 3. NEVER call the actual fetch/release                                   │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("should propagate ClarityBurstAbstainError when NETWORK_IO gate denies access", async () => {
      const abstainError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CLARIFY",
        reason: "network_io_denied",
        contractId: "NETWORK_IO_FIRECRAWL",
        instructions: "Firecrawl API request blocked by ClarityBurst gate",
      });

      fetchWithWebToolsNetworkGuardSpy.mockRejectedValueOnce(abstainError);

      const params = {
        url: "https://example.com",
        extractMode: "markdown" as const,
        apiKey: "test-key",
        baseUrl: "https://api.firecrawl.dev",
        onlyMainContent: true,
        maxAgeMs: 3600000,
        proxy: "auto" as const,
        storeInCache: true,
        timeoutSeconds: 30,
      };

      await expect(webFetchModule.fetchFirecrawlContent(params)).rejects.toThrow(ClarityBurstAbstainError);

      // Assert: Gate was called (meaning abstain error occurred before network I/O)
      expect(fetchWithWebToolsNetworkGuardSpy).toHaveBeenCalledTimes(1);
    });

    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │ INVARIANT: No release() should be called if gate fails before network I/O  │
     * │                                                                            │
     * │ The release() is only obtained from the gated wrapper's GuardedFetchResult.│
     * │ If the wrapper rejects before returning a result, there's nothing to       │
     * │ release.                                                                   │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("should not call release() when gate fails", async () => {
      const abstainError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CONFIRM",
        reason: "requires_user_confirmation",
        contractId: null,
        instructions: "User must approve Firecrawl request",
      });

      fetchWithWebToolsNetworkGuardSpy.mockRejectedValueOnce(abstainError);

      const params = {
        url: "https://example.com",
        extractMode: "markdown" as const,
        apiKey: "test-key",
        baseUrl: "https://api.firecrawl.dev",
        onlyMainContent: false,
        maxAgeMs: 0,
        proxy: "stealth" as const,
        storeInCache: false,
        timeoutSeconds: 60,
      };

      try {
        await webFetchModule.fetchFirecrawlContent(params);
      } catch (e) {
        expect(e).toBeInstanceOf(ClarityBurstAbstainError);
      }

      // Assert: release() was never called (it was never obtained)
      expect(mockRelease).not.toHaveBeenCalled();
    });
  });

  describe("request semantics: identical to original bare fetch()", () => {
    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │ INVARIANT: Request must be wrapped by fetchWithWebToolsNetworkGuard       │
     * │                                                                            │
     * │ The wrapper is called with URL, RequestInit, and timeout, which allows    │
     * │ the gating layer to inspect and authorize the network operation before    │
     * │ the actual fetch is made.                                                  │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("should call fetchWithWebToolsNetworkGuard instead of bare fetch", async () => {
      const guardedResult: GuardedFetchResult = {
        response: mockResponse as Response,
        finalUrl: "https://api.firecrawl.dev/scrape",
        release: mockRelease,
      };

      fetchWithWebToolsNetworkGuardSpy.mockResolvedValueOnce(guardedResult);

      const params = {
        url: "https://example.com",
        extractMode: "markdown" as const,
        apiKey: "test-api-key-123",
        baseUrl: "https://api.firecrawl.dev",
        onlyMainContent: true,
        maxAgeMs: 172800000,
        proxy: "basic" as const,
        storeInCache: true,
        timeoutSeconds: 45,
      };

      await webFetchModule.fetchFirecrawlContent(params);

      // Assert: Gated wrapper was called (instead of bare fetch)
      expect(fetchWithWebToolsNetworkGuardSpy).toHaveBeenCalledTimes(1);

      // Assert: Parameters passed have POST method, authorization header, and body
      const callArgs = fetchWithWebToolsNetworkGuardSpy.mock.calls[0][0];
      expect(callArgs.url).toContain("api.firecrawl.dev");
      expect(callArgs.init?.method).toBe("POST");
      expect((callArgs.init?.headers as Record<string, string>).Authorization).toContain("Bearer");
      expect(callArgs.timeoutSeconds).toBe(45);
    });
  });

  describe("response handling: identical to original fetch()", () => {
    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │ INVARIANT: Response handling must match original bare fetch() behavior     │
     * │                                                                            │
     * │ 1. Check res.ok to determine success                                      │
     * │ 2. Parse res.json() to extract payload                                    │
     * │ 3. Check payload.success === false for additional error signals           │
     * │ 4. Use res.status and payload.error in error messages                     │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("should handle successful Firecrawl response identically to original", async () => {
      const guardedResult: GuardedFetchResult = {
        response: mockResponse as Response,
        finalUrl: "https://api.firecrawl.dev/scrape",
        release: mockRelease,
      };

      fetchWithWebToolsNetworkGuardSpy.mockResolvedValueOnce(guardedResult);

      const params = {
        url: "https://example.com",
        extractMode: "markdown" as const,
        apiKey: "key",
        baseUrl: "https://api.firecrawl.dev",
        onlyMainContent: true,
        maxAgeMs: 0,
        proxy: "auto" as const,
        storeInCache: false,
        timeoutSeconds: 30,
      };

      const result = await webFetchModule.fetchFirecrawlContent(params);

      expect(result).toEqual({
        text: "# Test Content",
        title: "Test Title",
        finalUrl: "https://example.com",
        status: 200,
        warning: undefined,
      });

      // Assert: release() was called in finally block
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │ INVARIANT: Error response must be handled identically to original         │
     * │                                                                            │
     * │ When res.ok === false, should throw error with status and detail          │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("should throw error when response is not ok", async () => {
      const errorResponse: Partial<Response> = {
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: vi.fn().mockResolvedValue({
          success: false,
          error: "API key invalid",
        }),
      };

      const guardedResult: GuardedFetchResult = {
        response: errorResponse as Response,
        finalUrl: "https://api.firecrawl.dev/scrape",
        release: mockRelease,
      };

      fetchWithWebToolsNetworkGuardSpy.mockResolvedValueOnce(guardedResult);

      const params = {
        url: "https://example.com",
        extractMode: "markdown" as const,
        apiKey: "invalid-key",
        baseUrl: "https://api.firecrawl.dev",
        onlyMainContent: false,
        maxAgeMs: 0,
        proxy: "auto" as const,
        storeInCache: false,
        timeoutSeconds: 30,
      };

      await expect(webFetchModule.fetchFirecrawlContent(params)).rejects.toThrow(
        "Firecrawl fetch failed (403)"
      );

      // Assert: release() was still called in finally block
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │ INVARIANT: When res.ok is true but payload.success === false, throw error │
     * │                                                                            │
     * │ Some APIs return 200 with success:false to signal application-level error │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("should throw error when payload.success is false even with res.ok", async () => {
      const successCodeErrorPayload: Partial<Response> = {
        ok: true,
        status: 200,
        statusText: "OK",
        json: vi.fn().mockResolvedValue({
          success: false,
          error: "Content extraction failed",
        }),
      };

      const guardedResult: GuardedFetchResult = {
        response: successCodeErrorPayload as Response,
        finalUrl: "https://api.firecrawl.dev/scrape",
        release: mockRelease,
      };

      fetchWithWebToolsNetworkGuardSpy.mockResolvedValueOnce(guardedResult);

      const params = {
        url: "https://example.com",
        extractMode: "markdown" as const,
        apiKey: "key",
        baseUrl: "https://api.firecrawl.dev",
        onlyMainContent: true,
        maxAgeMs: 0,
        proxy: "auto" as const,
        storeInCache: false,
        timeoutSeconds: 30,
      };

      await expect(webFetchModule.fetchFirecrawlContent(params)).rejects.toThrow(
        "Content extraction failed"
      );

      // Assert: release() was still called in finally block
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });

  describe("cleanup: release() called in finally", () => {
    /**
     * ┌────────────────────────────────────────────────────────────────────────────┐
     * │ INVARIANT: release() must be called in finally block                      │
     * │                                                                            │
     * │ This ensures cleanup happens even if:                                      │
     * │ 1. Response parsing succeeds                                               │
     * │ 2. Response parsing fails (throws error)                                   │
     * │ 3. Payload processing throws error                                         │
     * │                                                                            │
     * │ The release() function ensures proper resource cleanup (stream draining,   │
     * │ connection pool return, etc.)                                              │
     * └────────────────────────────────────────────────────────────────────────────┘
     */
    it("should call release() even if response.json() throws", async () => {
      const badJsonResponse: Partial<Response> = {
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValueOnce(new SyntaxError("Invalid JSON")),
      };

      const guardedResult: GuardedFetchResult = {
        response: badJsonResponse as Response,
        finalUrl: "https://api.firecrawl.dev/scrape",
        release: mockRelease,
      };

      fetchWithWebToolsNetworkGuardSpy.mockResolvedValueOnce(guardedResult);

      const params = {
        url: "https://example.com",
        extractMode: "markdown" as const,
        apiKey: "key",
        baseUrl: "https://api.firecrawl.dev",
        onlyMainContent: false,
        maxAgeMs: 0,
        proxy: "auto" as const,
        storeInCache: false,
        timeoutSeconds: 30,
      };

      await expect(webFetchModule.fetchFirecrawlContent(params)).rejects.toThrow();

      // Assert: release() was called despite error
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    it("should call release() even if payload verification throws", async () => {
      const goodResponse: Partial<Response> = {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValueOnce({
          success: false, // This triggers error path
          error: "Extraction failed",
        }),
      };

      const guardedResult: GuardedFetchResult = {
        response: goodResponse as Response,
        finalUrl: "https://api.firecrawl.dev/scrape",
        release: mockRelease,
      };

      fetchWithWebToolsNetworkGuardSpy.mockResolvedValueOnce(guardedResult);

      const params = {
        url: "https://example.com",
        extractMode: "markdown" as const,
        apiKey: "key",
        baseUrl: "https://api.firecrawl.dev",
        onlyMainContent: true,
        maxAgeMs: 0,
        proxy: "auto" as const,
        storeInCache: false,
        timeoutSeconds: 30,
      };

      // Should throw because success is false
      await expect(webFetchModule.fetchFirecrawlContent(params)).rejects.toThrow("Extraction failed");

      // Assert: release() was called despite error
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });
  });
});
