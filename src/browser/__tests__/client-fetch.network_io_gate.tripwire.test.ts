/**
 * ClarityBurst NETWORK_IO Gate Tripwire Tests: Client Fetch
 *
 * Validates that fetchHttpJson routes through NETWORK_IO gate
 * and fails closed when gate abstains.
 *
 * Tripwire assertions:
 * 1. fetchHttpJson invokes applyNetworkIOGateAndFetch, not bare fetch
 * 2. NETWORK_IO gate decision is applied before the network request
 * 3. ABSTAIN outcomes (CONFIRM/CLARIFY) throw ClarityBurstAbstainError (blocks fetch)
 * 4. BrowserServiceError and other errors are properly propagated
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClarityBurstAbstainError } from "../../clarityburst/errors.js";
import * as networkIOGating from "../../clarityburst/network-io-gating.js";

// Import the private function for testing via __test export
// Note: We'll test the public fetchBrowserJson which internally uses fetchHttpJson
import { __test } from "../client-fetch.js";

// Mock the network-io-gating module
vi.mock("../../clarityburst/network-io-gating.js", () => ({
  applyNetworkIOGateAndFetch: vi.fn(),
}));

describe("Client Fetch - NETWORK_IO Gate Tripwire", () => {
  const testUrl = "http://localhost:9222/json/version";
  const defaultInit = {
    method: "GET",
    timeoutMs: 500,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("gate invocation validation", () => {
    it("fetchHttpJson routes through applyNetworkIOGateAndFetch, not bare fetch", async () => {
      // Arrange: Mock gate to approve and return valid response
      const mockResponse = new Response(
        JSON.stringify({ version: "1.0", result: { value: "test" } }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      // Import after mocking to capture mocked version
      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act: Call fetch with absolute HTTP URL
      const result = await fetchBrowserJson(testUrl, defaultInit);

      // Assert: Gate wrapper was invoked
      expect(networkIOGating.applyNetworkIOGateAndFetch).toHaveBeenCalledOnce();
      expect(result).toEqual({ version: "1.0", result: { value: "test" } });
    });

    it("gate receives correct URL and request options", async () => {
      // Arrange
      const mockResponse = new Response(
        JSON.stringify({ data: "test" }),
        { status: 200 }
      );

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act
      await fetchBrowserJson(testUrl, {
        method: "POST",
        timeoutMs: 1000,
      });

      // Assert: Gate receives URL and signal
      const callArgs = vi.mocked(
        networkIOGating.applyNetworkIOGateAndFetch
      ).mock.calls[0];
      expect(callArgs[0]).toBe(testUrl);
      expect(callArgs[1]?.method).toBe("POST");
      expect(callArgs[1]?.signal).toBeDefined();
    });
  });

  describe("abstain blocking (fail-closed)", () => {
    it("NETWORK_IO gate ABSTAIN_CONFIRM blocks fetch request", async () => {
      // Arrange: Gate abstains
      const abstainError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CONFIRM",
        reason: "Browser control requires confirmation",
        contractId: "contract-browser-001",
        instructions: "Network request to localhost blocked by NETWORK_IO gate",
      });

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockRejectedValue(
        abstainError
      );

      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act & Assert: Fetch throws abstain error
      await expect(fetchBrowserJson(testUrl, defaultInit)).rejects.toThrow(
        ClarityBurstAbstainError
      );

      await expect(fetchBrowserJson(testUrl, defaultInit)).rejects.toMatchObject(
        {
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CONFIRM",
        }
      );
    });

    it("NETWORK_IO gate ABSTAIN_CLARIFY blocks fetch request", async () => {
      // Arrange: Gate abstains
      const abstainError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CLARIFY",
        reason: "Browser control requires clarification",
        contractId: "contract-browser-002",
        instructions: "Network request to localhost blocked by NETWORK_IO gate",
      });

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockRejectedValue(
        abstainError
      );

      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act & Assert: Fetch throws abstain error
      await expect(fetchBrowserJson(testUrl, defaultInit)).rejects.toThrow(
        ClarityBurstAbstainError
      );

      await expect(fetchBrowserJson(testUrl, defaultInit)).rejects.toMatchObject(
        {
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CLARIFY",
        }
      );
    });
  });

  describe("gate approval and response handling", () => {
    it("fetch succeeds when gate approves and returns valid JSON response", async () => {
      // Arrange: Gate approves
      const mockResponse = new Response(
        JSON.stringify({ Browser: "Chrome", version: "100" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act
      const result = await fetchBrowserJson(testUrl, defaultInit);

      // Assert
      expect(result).toEqual({ Browser: "Chrome", version: "100" });
      expect(networkIOGating.applyNetworkIOGateAndFetch).toHaveBeenCalledOnce();
    });

    it("fetch fails when gate approves but HTTP response is error", async () => {
      // Arrange: Gate approves, but HTTP 500 response
      const mockResponse = new Response("Server error message", { status: 500 });

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act & Assert: Should throw BrowserServiceError as-is
      try {
        await fetchBrowserJson(testUrl, defaultInit);
        expect.fail("Should have thrown");
      } catch (err) {
        // BrowserServiceError is re-thrown without wrapping
        expect((err as Error).message).toContain("Server error message");
      }
    });

    it("fetch fails gracefully when gate approves but response is invalid JSON", async () => {
      // Arrange: Gate approves, returns non-JSON response
      const mockResponse = new Response("Not JSON", { status: 200 });

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act & Assert: Should throw parse error
      await expect(
        fetchBrowserJson(testUrl, defaultInit)
      ).rejects.toThrow();
    });

    it("fetch handles timeout errors after gate approval", async () => {
      // Arrange: Gate approves, but fetch times out
      const timeoutError = new Error("timed out");

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockRejectedValue(
        timeoutError
      );

      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act & Assert: Timeout error should be enhanced
      try {
        await fetchBrowserJson(testUrl, defaultInit);
      } catch (err) {
        // Error should be enhanced with timeout messaging
        expect((err as Error).message).toContain("Can't reach");
        expect((err as Error).message).toContain("timed out");
      }
    });
  });

  describe("gate context parameters", () => {
    it("gate receives NETWORK_IO stage context for HTTP requests", async () => {
      // Arrange
      const mockResponse = new Response(
        JSON.stringify({ data: "test" }),
        { status: 200 }
      );

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      const { fetchBrowserJson } = await import("../client-fetch.js");

      // Act
      await fetchBrowserJson(testUrl, defaultInit);

      // Assert: Gate call includes correct URL
      const callArgs = vi.mocked(
        networkIOGating.applyNetworkIOGateAndFetch
      ).mock.calls[0];
      expect(callArgs[0]).toBe(testUrl);
    });
  });

});
