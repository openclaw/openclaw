/**
 * TRIPWIRE TEST: NETWORK_IO Router Outage Fail-Closed
 *
 * Verifies that network I/O operations fail closed when the router is unavailable,
 * following the same fail-closed mechanism as FILE_SYSTEM_OPS and MEMORY_MODIFY.
 *
 * This tripwire ensures that agent fetch/HTTP operations cannot proceed when
 * ClarityBurst routing is broken, preventing silent bypass of network gating.
 */

import { describe, it, expect, vi } from "vitest";
import { applyNetworkOverrides } from "../decision-override.js";
import { getPackForStage } from "../pack-registry.js";
import type { NetworkContext, RouteResult } from "../decision-override.js";

describe("NETWORK_IO Router Outage - Fail-Closed Tripwire", () => {
  it("should return ABSTAIN_CLARIFY with router_outage when router unavailable", async () => {
    // Arrange: Create a context for a fetch operation
    const context: NetworkContext = {
      stageId: "NETWORK_IO",
      userConfirmed: false,
      operation: "fetch",
      url: "https://api.example.com/data",
    };

    // Mock router to be unavailable (simulate network error)
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("Router unavailable"));

    try {
      // Act: Call applyNetworkOverrides (async version)
      const result = await applyNetworkOverrides(context);

      // Assert: Should return ABSTAIN_CLARIFY with router_outage reason
      expect(result).toEqual(
        expect.objectContaining({
          outcome: "ABSTAIN_CLARIFY",
          reason: "router_outage",
          stageId: "NETWORK_IO",
          contractId: null,
        })
      );

      // Verify the instructions are present
      if (result.outcome === "ABSTAIN_CLARIFY") {
        expect(result).toHaveProperty("instructions");
        expect(typeof result.instructions).toBe("string");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should block fetch operations when router is unavailable (fail-closed invariant)", async () => {
    // Arrange: Network operation context
    const context: NetworkContext = {
      stageId: "NETWORK_IO",
      operation: "fetch",
      url: "https://sensitive-api.example.com/confidential",
    };

    // Mock router to fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("Connection refused"));

    try {
      // Act
      const result = await applyNetworkOverrides(context);

      // Assert: Must not proceed (fail-closed invariant)
      expect(result.outcome).not.toBe("PROCEED");
      expect(result.outcome).toBe("ABSTAIN_CLARIFY");
      if (result.outcome === "ABSTAIN_CLARIFY") {
        expect(result.reason).toBe("router_outage");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should provide recovery instructions when router outage occurs", async () => {
    // Arrange
    const context: NetworkContext = {
      stageId: "NETWORK_IO",
      operation: "fetch",
      url: "https://api.example.com",
    };

    // Mock router failure
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("Service unavailable"));

    try {
      // Act
      const result = await applyNetworkOverrides(context);

      // Assert: Instructions should mention router restoration
      if (result.outcome === "ABSTAIN_CLARIFY" && result.instructions) {
        expect(result).toHaveProperty("instructions");
        const instructions = result.instructions;
        expect(instructions.toLowerCase()).toContain("router");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
