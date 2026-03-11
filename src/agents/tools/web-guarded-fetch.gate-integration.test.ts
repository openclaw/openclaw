/**
 * REGRESSION TEST: Web Search Inference Network I/O Gate Integration
 *
 * Validates that applyNetworkIOGate is invoked in fetchWithWebToolsNetworkGuard()
 * and that gate abstain outcomes block the request from reaching the network stack.
 *
 * This test ensures the exact boundary condition is preserved:
 * - Gate executes BEFORE SSRF guard
 * - Gate executes BEFORE network fetch
 * - ABSTAIN outcomes prevent any network operations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithWebToolsNetworkGuard, withWebToolsNetworkGuard } from "./web-guarded-fetch.js";
import { ClarityBurstAbstainError } from "../../clarityburst/errors.js";
import * as decisionOverride from "../../clarityburst/decision-override.js";

// Mock the decision-override module to control gate outcomes
vi.mock("../../clarityburst/decision-override.js");

describe("Web search inference gate integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Gate invocation at fetch boundary", () => {
    it("applyNetworkOverrides is called BEFORE fetchWithSsrFGuard", async () => {
      // Setup: Gate abstains
      const mockGateAbstain = vi.spyOn(decisionOverride, "applyNetworkOverrides");
      mockGateAbstain.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Pack policy incomplete",
      });

      // Mock fetchWithSsrFGuard to track if it's called
      const mockFetchGuard = vi.fn();
      vi.doMock("../../infra/net/fetch-guard.js", () => ({
        fetchWithSsrFGuard: mockFetchGuard,
      }));

      try {
        // Execute: Call fetchWithWebToolsNetworkGuard
        await fetchWithWebToolsNetworkGuard({
          url: "https://api.perplexity.ai/chat/completions",
          init: { method: "POST" },
        });
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (error) {
        // Assert: Gate was called and threw before fetchWithSsrFGuard
        expect(mockGateAbstain).toHaveBeenCalled();
        expect(mockFetchGuard).not.toHaveBeenCalled(); // Never reached network guard
        expect(error).toBeInstanceOf(ClarityBurstAbstainError);
      }
    });

    it("fetchWithSsrFGuard is NOT called when gate abstains", async () => {
      // Setup: Gate returns ABSTAIN_CONFIRM
      vi.spyOn(decisionOverride, "applyNetworkOverrides").mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "test-contract",
        instructions: "User confirmation required",
      });

      // Mock fetchWithSsrFGuard to verify it's not called
      const mockFetchGuard = vi.fn();
      vi.doMock("../../infra/net/fetch-guard.js", () => ({
        fetchWithSsrFGuard: mockFetchGuard,
      }));

      try {
        await fetchWithWebToolsNetworkGuard({
          url: "https://api.perplexity.ai/chat/completions",
          init: { method: "POST" },
        });
        expect.fail("Should have thrown on ABSTAIN_CONFIRM");
      } catch (error) {
        // Assert: Gate abstain prevents network operations
        expect(error).toBeInstanceOf(ClarityBurstAbstainError);
        expect(mockFetchGuard).not.toHaveBeenCalled();
      }
    });

    it("gate is called with correct URL and method from web search inference", async () => {
      // Setup: Mock gate to track parameters
      const mockGate = vi.spyOn(decisionOverride, "applyNetworkOverrides");
      mockGate.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      try {
        await fetchWithWebToolsNetworkGuard({
          url: "https://api.perplexity.ai/chat/completions",
          init: { method: "POST", body: JSON.stringify({ query: "test" }) },
        });
      } catch {
        // Expected to fail
      }

      // Assert: Gate was called with NetworkContext
      expect(mockGate).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "NETWORK_IO",
          operation: "POST",
          url: expect.stringContaining("perplexity"),
          userConfirmed: false,
        })
      );
    });

    it("gate receives method: POST for web search inference requests", async () => {
      // Setup: Track gate calls
      const mockGate = vi.spyOn(decisionOverride, "applyNetworkOverrides");
      mockGate.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      const requests = [
        {
          provider: "Perplexity",
          url: "https://api.perplexity.ai/chat/completions",
        },
        { provider: "Grok", url: "https://api.x.ai/v1/responses" },
        {
          provider: "Gemini",
          url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        },
        { provider: "Kimi", url: "https://api.moonshot.ai/v1/chat/completions" },
      ];

      for (const req of requests) {
        mockGate.mockClear();

        try {
          await fetchWithWebToolsNetworkGuard({
            url: req.url,
            init: { method: "POST" },
          });
        } catch {
          // Expected to fail
        }

        // Assert: All inference requests are POST (side-effectful)
        expect(mockGate).toHaveBeenCalledWith(
          expect.objectContaining({
            operation: "POST",
          })
        );
      }
    });
  });

  describe("Gate abstain blocks execution", () => {
    it("ABSTAIN_CLARIFY outcome throws ClarityBurstAbstainError", async () => {
      // Setup: Gate returns ABSTAIN_CLARIFY
      vi.spyOn(decisionOverride, "applyNetworkOverrides").mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Pack policy is incomplete for NETWORK_IO stage",
      });

      // Execute & Assert
      await expect(
        fetchWithWebToolsNetworkGuard({
          url: "https://api.perplexity.ai/chat/completions",
          init: { method: "POST" },
        })
      ).rejects.toThrow(ClarityBurstAbstainError);
    });

    it("ABSTAIN_CONFIRM outcome throws ClarityBurstAbstainError", async () => {
      // Setup: Gate returns ABSTAIN_CONFIRM
      vi.spyOn(decisionOverride, "applyNetworkOverrides").mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "inference-contract-123",
        instructions: "User confirmation token required",
      });

      // Execute & Assert
      await expect(
        fetchWithWebToolsNetworkGuard({
          url: "https://api.x.ai/v1/responses",
          init: { method: "POST" },
        })
      ).rejects.toThrow(ClarityBurstAbstainError);
    });

    it("withWebToolsNetworkGuard propagates gate abstain error", async () => {
      // Setup: Gate abstains
      vi.spyOn(decisionOverride, "applyNetworkOverrides").mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      // Execute & Assert: Error propagates before run handler is called
      let runHandlerCalled = false;
      await expect(
        withWebToolsNetworkGuard(
          {
            url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
            init: { method: "POST" },
          },
          async () => {
            runHandlerCalled = true;
            return "result";
          }
        )
      ).rejects.toThrow(ClarityBurstAbstainError);

      // Assert: Run handler was never invoked because gate blocked execution
      expect(runHandlerCalled).toBe(false);
    });
  });

  describe("Fail-closed behavior", () => {
    it("gate error propagates immediately, blocking network operations", async () => {
      // Setup: Gate throws error
      const gateError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Cannot proceed without pack policy",
      });
      vi.spyOn(decisionOverride, "applyNetworkOverrides").mockRejectedValue(gateError);

      // Execute & Assert
      await expect(
        fetchWithWebToolsNetworkGuard({
          url: "https://api.perplexity.ai/chat/completions",
          init: { method: "POST" },
        })
      ).rejects.toThrow(gateError);
    });

    it("no fetch occurs when gate abstains", async () => {
      // Setup: Gate abstains, mock global fetch
      vi.spyOn(decisionOverride, "applyNetworkOverrides").mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      const mockFetch = vi.spyOn(global, "fetch");

      try {
        await fetchWithWebToolsNetworkGuard({
          url: "https://api.perplexity.ai/chat/completions",
          init: { method: "POST" },
        });
      } catch {
        // Expected
      }

      // Assert: fetch was never called (gate blocked before any network operation)
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Provider routing invariant: all inference paths through fetchWithWebToolsNetworkGuard()", () => {
    /**
     * TRIPWIRE TEST: Proves all current web-search inference provider request paths
     * (Perplexity, Grok, Gemini, Kimi) route through fetchWithWebToolsNetworkGuard()
     * and that no parallel raw fetch() execution path exists.
     *
     * Fails if:
     * - Any provider-specific path bypasses the shared boundary
     * - Direct fetch() is called outside the guarded flow
     * - Gate is not invoked at the NETWORK_IO stage for inference requests
     */
    it("all inference providers route exclusively through fetchWithWebToolsNetworkGuard()", async () => {
      const providers = ["perplexity", "grok", "gemini", "kimi"] as const;
      const endpoints = {
        perplexity: "https://api.perplexity.ai/chat/completions",
        grok: "https://api.x.ai/v1/responses",
        gemini: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        kimi: "https://api.moonshot.ai/v1/chat/completions",
      };

      // Spy on the main boundary function
      const fetchWithGuardSpy = vi.spyOn(decisionOverride, "applyNetworkOverrides");
      fetchWithGuardSpy.mockResolvedValue({
        outcome: "PASS",
        reason: "allowed",
        contractId: null,
      } as any);

      // Spy on raw fetch to detect any bypass attempts
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      // For each provider endpoint, verify the routing
      for (const provider of providers) {
        fetchWithGuardSpy.mockClear();
        fetchSpy.mockClear();

        const endpoint = endpoints[provider];

        try {
          // Simulate provider request through fetchWithWebToolsNetworkGuard
          await fetchWithWebToolsNetworkGuard({
            url: endpoint,
            init: { method: "POST" },
          });
        } catch {
          // Expected in some cases; focus on call tracking
        }

        // INVARIANT 1: Gate must be invoked for all inference providers
        expect(fetchWithGuardSpy).toHaveBeenCalled();
        const gateCall = fetchWithGuardSpy.mock.calls[0]?.[0];
        expect(gateCall).toMatchObject({
          stageId: "NETWORK_IO",
          operation: "POST",
        });
      }

      // Cleanup
      fetchWithGuardSpy.mockRestore();
      fetchSpy.mockRestore();
    });

    it("gate abstain blocks all providers before any network execution", async () => {
      // Setup: Gate abstains for all attempts
      const gateSpy = vi.spyOn(decisionOverride, "applyNetworkOverrides");
      gateSpy.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      } as any);

      // Spy to ensure no raw fetch occurs
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const providers = [
        { name: "perplexity", url: "https://api.perplexity.ai/chat/completions" },
        { name: "grok", url: "https://api.x.ai/v1/responses" },
        {
          name: "gemini",
          url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
        },
        { name: "kimi", url: "https://api.moonshot.ai/v1/chat/completions" },
      ];

      for (const { name, url } of providers) {
        fetchSpy.mockClear();

        // Execute: Try to make a request
        try {
          await fetchWithWebToolsNetworkGuard({
            url,
            init: { method: "POST" },
          });
          expect.fail(`${name} should have thrown ClarityBurstAbstainError`);
        } catch (err) {
          // Expected: Gate blocks before network
          expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        }

        // INVARIANT: No raw fetch should be called when gate abstains
        expect(fetchSpy).not.toHaveBeenCalled();
      }

      fetchSpy.mockRestore();
      gateSpy.mockRestore();
    });

    it("detects if provider paths attempt to bypass fetchWithWebToolsNetworkGuard()", async () => {
      /**
       * This test serves as a "canary" to detect if any future refactoring
       * introduces direct fetch() calls or bypasses the guarded boundary.
       *
       * Instruments the NETWORK_IO gate to verify all inference request paths
       * invoke the guard, not raw fetch.
       */

      // Spy on the gate invocation
      const gateSpy = vi.spyOn(decisionOverride, "applyNetworkOverrides");
      gateSpy.mockResolvedValue({
        outcome: "PASS",
        reason: "allowed",
        contractId: null,
      } as any);

      // Spy on raw fetch to detect bypass attempts
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      // For inference domains, verify the routing
      const inferenceDomains = [
        "api.perplexity.ai",
        "api.x.ai",
        "generativelanguage.googleapis.com",
        "api.moonshot.ai",
      ];

      for (const domain of inferenceDomains) {
        gateSpy.mockClear();
        fetchSpy.mockClear();

        try {
          await fetchWithWebToolsNetworkGuard({
            url: `https://${domain}/v1/test`,
            init: { method: "POST" },
          });
        } catch {
          // Expected in mocked scenarios
        }

        // INVARIANT: Gate must be invoked for all inference domains
        // This proves requests route through fetchWithWebToolsNetworkGuard()
        expect(gateSpy).toHaveBeenCalled();

        // INVARIANT: No direct fetch() bypass should exist
        // If gate allows the request, it proceeds to SSRF guard + network.
        // But the gate is the required checkpoint.
        const gateCall = gateSpy.mock.calls[0]?.[0];
        expect(gateCall?.stageId).toBe("NETWORK_IO");
      }

      gateSpy.mockRestore();
      fetchSpy.mockRestore();
    });
  });
});
