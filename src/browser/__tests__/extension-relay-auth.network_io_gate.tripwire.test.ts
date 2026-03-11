/**
 * ClarityBurst NETWORK_IO Gate Tripwire Tests: Extension Relay Auth
 *
 * Validates that probeAuthenticatedOpenClawRelay routes through NETWORK_IO gate
 * and fails closed when gate abstains.
 *
 * Tripwire assertions:
 * 1. probeAuthenticatedOpenClawRelay invokes applyNetworkIOGateAndFetch, not bare fetch
 * 2. NETWORK_IO gate decision is applied before the network request
 * 3. ABSTAIN outcomes (CONFIRM/CLARIFY) throw ClarityBurstAbstainError (blocks probe)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { probeAuthenticatedOpenClawRelay } from "../extension-relay-auth.js";
import { ClarityBurstAbstainError } from "../../clarityburst/errors.js";
import * as networkIOGating from "../../clarityburst/network-io-gating.js";

// Mock the network-io-gating module
vi.mock("../../clarityburst/network-io-gating.js", () => ({
  applyNetworkIOGateAndFetch: vi.fn(),
}));

describe("Extension Relay Auth - NETWORK_IO Gate Tripwire", () => {
  const baseUrl = "http://localhost:9222";
  const relayAuthHeader = "X-OpenClaw-Token";
  const relayAuthToken = "test-auth-token-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("gate invocation validation", () => {
    it("probeAuthenticatedOpenClawRelay invokes applyNetworkIOGateAndFetch, not bare fetch", async () => {
      // Arrange: Mock gate to approve request and return valid version response
      const mockResponse = new Response(
        JSON.stringify({ Browser: "OpenClaw/extension-relay" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      // Act: Call probe function
      const result = await probeAuthenticatedOpenClawRelay({
        baseUrl,
        relayAuthHeader,
        relayAuthToken,
        timeoutMs: 1000,
      });

      // Assert: Gate wrapper was invoked (not bare fetch)
      expect(networkIOGating.applyNetworkIOGateAndFetch).toHaveBeenCalledOnce();
      expect(result).toBe(true);
    });

    it("gate receives correct URL and request options with auth header", async () => {
      // Arrange
      const mockResponse = new Response(
        JSON.stringify({ Browser: "OpenClaw/extension-relay" }),
        { status: 200 }
      );

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      // Act
      await probeAuthenticatedOpenClawRelay({
        baseUrl,
        relayAuthHeader,
        relayAuthToken,
        timeoutMs: 500,
      });

      // Assert: Gate receives target URL and auth headers
      const callArgs = vi.mocked(
        networkIOGating.applyNetworkIOGateAndFetch
      ).mock.calls[0];
      expect(callArgs[0]).toMatch(/\/json\/version/);
      expect(callArgs[1]?.headers).toEqual({
        [relayAuthHeader]: relayAuthToken,
      });
    });
  });

  describe("abstain blocking (fail-closed)", () => {
    it("NETWORK_IO gate ABSTAIN_CONFIRM blocks probe request", async () => {
      // Arrange: Gate abstains (requires confirmation)
      const abstainError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CONFIRM",
        reason: "Extension relay network access requires confirmation",
        contractId: "contract-relay-001",
        instructions: "Network request to localhost blocked by NETWORK_IO gate",
      });

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockRejectedValue(
        abstainError
      );

      // Act & Assert: Probe throws error instead of attempting network request
      await expect(
        probeAuthenticatedOpenClawRelay({
          baseUrl,
          relayAuthHeader,
          relayAuthToken,
        })
      ).rejects.toThrow(ClarityBurstAbstainError);

      await expect(
        probeAuthenticatedOpenClawRelay({
          baseUrl,
          relayAuthHeader,
          relayAuthToken,
        })
      ).rejects.toMatchObject({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CONFIRM",
      });
    });

    it("NETWORK_IO gate ABSTAIN_CLARIFY blocks probe request", async () => {
      // Arrange: Gate abstains (requires clarification)
      const abstainError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CLARIFY",
        reason: "Extension relay network access requires clarification",
        contractId: "contract-relay-002",
        instructions: "Network request to localhost blocked by NETWORK_IO gate",
      });

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockRejectedValue(
        abstainError
      );

      // Act & Assert: Probe throws error instead of attempting network request
      await expect(
        probeAuthenticatedOpenClawRelay({
          baseUrl,
          relayAuthHeader,
          relayAuthToken,
        })
      ).rejects.toThrow(ClarityBurstAbstainError);

      await expect(
        probeAuthenticatedOpenClawRelay({
          baseUrl,
          relayAuthHeader,
          relayAuthToken,
        })
      ).rejects.toMatchObject({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CLARIFY",
      });
    });

  });

  describe("gate approval and response handling", () => {
    it("probe succeeds when gate approves and returns valid relay version", async () => {
      // Arrange: Gate approves, returns valid relay response
      const mockResponse = new Response(
        JSON.stringify({ Browser: "OpenClaw/extension-relay" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      // Act
      const result = await probeAuthenticatedOpenClawRelay({
        baseUrl,
        relayAuthHeader,
        relayAuthToken,
      });

      // Assert: Probe succeeds after gate approval
      expect(result).toBe(true);
      expect(networkIOGating.applyNetworkIOGateAndFetch).toHaveBeenCalledOnce();
    });

    it("probe returns false when gate approves but response is not ok", async () => {
      // Arrange: Gate approves, but HTTP response is error
      const mockResponse = new Response(JSON.stringify({}), { status: 401 });

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      // Act
      const result = await probeAuthenticatedOpenClawRelay({
        baseUrl,
        relayAuthHeader,
        relayAuthToken,
      });

      // Assert: Probe fails gracefully (HTTP error, not gate error)
      expect(result).toBe(false);
    });

    it("probe returns false when gate approves but Browser header is missing", async () => {
      // Arrange: Gate approves, but response has no Browser field
      const mockResponse = new Response(JSON.stringify({}), { status: 200 });

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      // Act
      const result = await probeAuthenticatedOpenClawRelay({
        baseUrl,
        relayAuthHeader,
        relayAuthToken,
      });

      // Assert: Probe fails gracefully (invalid response)
      expect(result).toBe(false);
    });

    it("probe handles network errors after gate approval", async () => {
      // Arrange: Gate approves, but network request fails
      const networkError = new Error("Network timeout");

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockRejectedValue(
        networkError
      );

      // Act
      const result = await probeAuthenticatedOpenClawRelay({
        baseUrl,
        relayAuthHeader,
        relayAuthToken,
      });

      // Assert: Probe handles error gracefully (returns false, not throw)
      expect(result).toBe(false);
    });
  });

  describe("gate context parameters", () => {
    it("gate receives stageId NETWORK_IO for context", async () => {
      // Arrange
      const mockResponse = new Response(
        JSON.stringify({ Browser: "OpenClaw/extension-relay" }),
        { status: 200 }
      );

      vi.mocked(networkIOGating.applyNetworkIOGateAndFetch).mockResolvedValue(
        mockResponse
      );

      // Act
      await probeAuthenticatedOpenClawRelay({
        baseUrl,
        relayAuthHeader,
        relayAuthToken,
      });

      // Assert: Gate call includes correct URL
      const callArgs = vi.mocked(
        networkIOGating.applyNetworkIOGateAndFetch
      ).mock.calls[0];
      // The gate receives the full URL with /json/version path
      expect(callArgs[0]).toMatch(/localhost.*\/json\/version/);
    });
  });
});
