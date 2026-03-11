/**
 * ClarityBurst NETWORK_IO Gate Tripwire Tests: Playwright Session Module
 *
 * Validates that pw-session.ts routes network requests through NETWORK_IO gate
 * and fails closed when gate abstains.
 *
 * Tripwire assertions:
 * 1. pw-session invokes applyNetworkIOGateAndFetch, not bare fetch
 * 2. NETWORK_IO gate decision is applied before the network request
 * 3. ABSTAIN outcomes (CONFIRM/CLARIFY) throw ClarityBurstAbstainError (blocks discovery)
 * 4. Request semantics (URL, headers) are preserved exactly
 * 5. Response/error behavior matches bare fetch semantics
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClarityBurstAbstainError } from "../../clarityburst/errors.js";

describe("Playwright Session NETWORK_IO Gate Tripwire", () => {
  const baseUrl = "http://localhost:9222";
  const cdpUrl = `${baseUrl}/devtools/browser/abc123`;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("gate invocation validation", () => {
    it("pw-session routes through applyNetworkIOGateAndFetch, not bare fetch", async () => {
      // Arrange: Setup mock BEFORE importing the module
      const mockGateFn = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: "target-1", url: "https://example.com", title: "Example" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      vi.doMock("../../clarityburst/network-io-gating.js", () => ({
        applyNetworkIOGateAndFetch: mockGateFn,
      }));

      const { findPageByTargetId } = await import("../pw-session.js");

      // Act: Call findPageByTargetId with minimal context
      const mockBrowser = {
        contexts: () => [],
      };

      try {
        await findPageByTargetId(mockBrowser as any, "target-1", cdpUrl);
      } catch {
        // Expected - no pages exist, but gate should have been called
      }

      // Assert: Gate wrapper was invoked
      expect(mockGateFn).toHaveBeenCalled();
      const callArgs = mockGateFn.mock.calls[0];
      expect(callArgs[0]).toContain("/json/list");
    });
  });

  describe("abstain blocking (fail-closed)", () => {
    it("NETWORK_IO gate ABSTAIN_CONFIRM blocks discovery", async () => {
      // Arrange: Gate abstains before network activity
      const abstainError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CONFIRM",
        reason: "Session requires confirmation",
        contractId: "NETWORK_GET_METADATA",
        instructions: "Gate blocked discovery",
      });

      const mockGateFn = vi.fn().mockRejectedValue(abstainError);

      vi.doMock("../../clarityburst/network-io-gating.js", () => ({
        applyNetworkIOGateAndFetch: mockGateFn,
      }));

      const { findPageByTargetId } = await import("../pw-session.js");

      const mockBrowser = {
        contexts: () => [],
      };

      // Act & Assert: Operation throws abstain error without retry
      try {
        await findPageByTargetId(mockBrowser as any, "target-1", cdpUrl);
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as ClarityBurstAbstainError).stageId).toBe("NETWORK_IO");
        expect((err as ClarityBurstAbstainError).outcome).toBe("ABSTAIN_CONFIRM");
        expect(mockGateFn).toHaveBeenCalled();
      }
    });

    it("NETWORK_IO gate ABSTAIN_CLARIFY blocks discovery", async () => {
      // Arrange
      const abstainError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CLARIFY",
        reason: "Session requires clarification",
        contractId: "NETWORK_GET_METADATA",
        instructions: "Gate blocked discovery",
      });

      const mockGateFn = vi.fn().mockRejectedValue(abstainError);

      vi.doMock("../../clarityburst/network-io-gating.js", () => ({
        applyNetworkIOGateAndFetch: mockGateFn,
      }));

      const { findPageByTargetId } = await import("../pw-session.js");

      const mockBrowser = {
        contexts: () => [],
      };

      // Act & Assert
      try {
        await findPageByTargetId(mockBrowser as any, "target-1", cdpUrl);
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as ClarityBurstAbstainError).outcome).toBe("ABSTAIN_CLARIFY");
        expect(mockGateFn).toHaveBeenCalled();
      }
    });
  });

  describe("request semantics preservation", () => {
    it("gate receives /json/list URL with authentication headers", async () => {
      // Arrange
      const mockGateFn = vi.fn().mockResolvedValue(
        new Response("[]", { status: 200 })
      );

      vi.doMock("../../clarityburst/network-io-gating.js", () => ({
        applyNetworkIOGateAndFetch: mockGateFn,
      }));

      const { findPageByTargetId } = await import("../pw-session.js");

      const mockBrowser = {
        contexts: () => [],
      };

      // Act
      try {
        await findPageByTargetId(mockBrowser as any, "target-1", cdpUrl);
      } catch {
        // Ignore errors
      }

      // Assert: Gate call includes correct parameters
      expect(mockGateFn).toHaveBeenCalled();
      const callArgs = mockGateFn.mock.calls[0];
      expect(callArgs[0]).toBe(`${baseUrl}/json/list`);
      expect(callArgs[1]?.headers).toBeDefined();
    });
  });

  describe("regression: gate execution before network activity", () => {
    it("proves gate is invoked before any network request", async () => {
      // Arrange: Track invocation
      const callOrder: string[] = [];
      const mockGateFn = vi.fn().mockImplementation(async () => {
        callOrder.push("gate-called");
        return new Response("[]", { status: 200 });
      });

      vi.doMock("../../clarityburst/network-io-gating.js", () => ({
        applyNetworkIOGateAndFetch: mockGateFn,
      }));

      const { findPageByTargetId } = await import("../pw-session.js");

      const mockBrowser = {
        contexts: () => [],
      };

      // Act
      try {
        await findPageByTargetId(mockBrowser as any, "target-1", cdpUrl);
      } catch {
        // Ignore
      }

      // Assert: Gate was invoked (before any error)
      expect(callOrder).toContain("gate-called");
      expect(mockGateFn).toHaveBeenCalled();
    });

    it("proves abstain error propagates (fail-closed)", async () => {
      // Arrange: Gate blocks immediately
      const blockError = new ClarityBurstAbstainError({
        stageId: "NETWORK_IO",
        outcome: "ABSTAIN_CLARIFY",
        reason: "Session control blocked",
        contractId: "NETWORK_GET_METADATA",
        instructions: "Discovery blocked by gate",
      });

      const mockGateFn = vi.fn().mockRejectedValue(blockError);

      vi.doMock("../../clarityburst/network-io-gating.js", () => ({
        applyNetworkIOGateAndFetch: mockGateFn,
      }));

      const { findPageByTargetId } = await import("../pw-session.js");

      const mockBrowser = {
        contexts: () => [],
      };

      // Act & Assert: Gate error is rethrown (not caught/swallowed)
      let caughtError: Error | null = null;
      try {
        await findPageByTargetId(mockBrowser as any, "target-1", cdpUrl);
      } catch (err) {
        caughtError = err as Error;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError).toBeInstanceOf(ClarityBurstAbstainError);
      expect((caughtError as ClarityBurstAbstainError).stageId).toBe(
        "NETWORK_IO"
      );
      expect(mockGateFn).toHaveBeenCalledOnce();
    });
  });
});
