/**
 * Network I/O Gating Tests for ClarityBurst NETWORK_IO Stage
 *
 * This test suite validates the NETWORK_IO execution-boundary gating:
 * - Gate executes before fetch() call
 * - Gate outcome determines if request proceeds
 * - ABSTAIN outcomes throw ClarityBurstAbstainError immediately
 * - Request is NOT executed if gate abstains
 * - Logging captures contractId, outcome, method, and hostname
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ClarityBurstAbstainError } from "../errors.js";

// Mock the applyNetworkIOOverrides function
const mockApplyNetworkIOOverrides = vi.fn();
vi.mock("../decision-override.js", () => ({
  applyNetworkIOOverrides: mockApplyNetworkIOOverrides,
}));

// Mock the logging module
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock global fetch
const fetchMock = vi.fn();
global.fetch = fetchMock;

// Import after mocking
const { applyNetworkIOGateAndFetch } = await import("../network-io-gating.js");

describe("Network I/O Gating (NETWORK_IO Stage)", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    mockApplyNetworkIOOverrides.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("PROCEED outcome", () => {
    it("should execute fetch when gate returns PROCEED with contractId", async () => {
      const testUrl = "https://api.example.com/data";
      const testResponse = { ok: true, status: 200 };
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NETWORK_GET_PUBLIC",
      });
      fetchMock.mockResolvedValue(testResponse);

      const result = await applyNetworkIOGateAndFetch(testUrl, {
        method: "GET",
        headers: { Authorization: "Bearer token" },
      });

      expect(result).toBe(testResponse);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(testUrl, {
        method: "GET",
        headers: { Authorization: "Bearer token" },
      });
    });

    it("should execute fetch when gate returns PROCEED with null contractId", async () => {
      const testUrl = "https://api.example.com/public";
      const testResponse = { ok: true, status: 200 };
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      fetchMock.mockResolvedValue(testResponse);

      const result = await applyNetworkIOGateAndFetch(testUrl);

      expect(result).toBe(testResponse);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledWith(testUrl, undefined);
    });

    it("should preserve POST request with body when gate approves", async () => {
      const testUrl = "https://api.example.com/create";
      const testBody = JSON.stringify({ key: "value" });
      const testResponse = { ok: true, status: 201 };
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NETWORK_POST_DATA",
      });
      fetchMock.mockResolvedValue(testResponse);

      const result = await applyNetworkIOGateAndFetch(testUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: testBody,
      });

      expect(result).toBe(testResponse);
      expect(fetchMock).toHaveBeenCalledWith(testUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: testBody,
      });
    });
  });

  describe("ABSTAIN_CONFIRM outcome", () => {
    it("should throw ClarityBurstAbstainError when gate returns ABSTAIN_CONFIRM", async () => {
      const testUrl = "https://api.example.com/sensitive";
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NETWORK_HIGH_RISK_OPERATION",
        instructions: "This operation requires user confirmation. Contract NETWORK_HIGH_RISK_OPERATION has HIGH risk. Obtain explicit consent.",
      });

      await expect(
        applyNetworkIOGateAndFetch(testUrl, { method: "POST" })
      ).rejects.toThrow(ClarityBurstAbstainError);

      // Verify fetch was NOT called
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should throw with correct error properties on ABSTAIN_CONFIRM", async () => {
      const testUrl = "https://api.example.com/write";
      const contractId = "NETWORK_POST_SENSITIVE";
      const instructions = "Confirmation required for sensitive POST operation";
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId,
        instructions,
      });

      try {
        await applyNetworkIOGateAndFetch(testUrl, { method: "POST" });
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as any).outcome).toBe("ABSTAIN_CONFIRM");
        expect((err as any).contractId).toBe(contractId);
        expect((err as any).instructions).toContain(instructions);
        expect((err as any).stageId).toBe("NETWORK_IO");
      }
    });
  });

  describe("ABSTAIN_CLARIFY outcome", () => {
    it("should throw ClarityBurstAbstainError when gate returns ABSTAIN_CLARIFY", async () => {
      const testUrl = "https://api.example.com/uncertain";
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId: "NETWORK_UNCERTAIN_OPERATION",
        instructions: "Router uncertainty too high; clarification required before proceeding.",
      });

      await expect(
        applyNetworkIOGateAndFetch(testUrl, { method: "GET" })
      ).rejects.toThrow(ClarityBurstAbstainError);

      // Verify fetch was NOT called
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should throw with correct error properties on ABSTAIN_CLARIFY with ROUTER_UNAVAILABLE", async () => {
      const testUrl = "https://api.example.com/delete";
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "ROUTER_UNAVAILABLE",
        contractId: null,
        instructions: "The router is unavailable and network operations cannot proceed.",
      });

      try {
        await applyNetworkIOGateAndFetch(testUrl, { method: "DELETE" });
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as any).outcome).toBe("ABSTAIN_CLARIFY");
        expect((err as any).reason).toBe("ROUTER_UNAVAILABLE");
        expect((err as any).contractId).toBeNull();
      }
    });
  });

  describe("HTTP Method Extraction", () => {
    it("should extract GET method (default)", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NETWORK_GET_PUBLIC",
      });
      fetchMock.mockResolvedValue({ ok: true });

      await applyNetworkIOGateAndFetch("https://api.example.com/data");

      // Gate should be called with GET method
      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "GET",
        })
      );
    });

    it("should extract POST method from init", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NETWORK_POST_DATA",
      });
      fetchMock.mockResolvedValue({ ok: true });

      await applyNetworkIOGateAndFetch("https://api.example.com/create", {
        method: "POST",
      });

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "POST",
        })
      );
    });

    it("should handle PUT method", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NETWORK_PUT_UPDATE",
      });
      fetchMock.mockResolvedValue({ ok: true });

      await applyNetworkIOGateAndFetch("https://api.example.com/update", {
        method: "PUT",
      });

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "PUT",
        })
      );
    });

    it("should handle DELETE method", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NETWORK_DELETE_RESOURCE",
      });
      fetchMock.mockResolvedValue({ ok: true });

      await applyNetworkIOGateAndFetch("https://api.example.com/delete", {
        method: "DELETE",
      });

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "DELETE",
        })
      );
    });

    it("should normalize method to uppercase", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      fetchMock.mockResolvedValue({ ok: true });

      await applyNetworkIOGateAndFetch("https://api.example.com/test", {
        method: "post",
      });

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "POST",
        })
      );
    });
  });

  describe("URL Hostname Extraction", () => {
    it("should extract hostname from standard URL", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      fetchMock.mockResolvedValue({ ok: true });

      const url = "https://api.example.com/v1/data?param=value";
      await applyNetworkIOGateAndFetch(url);

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "api.example.com",
        })
      );
    });

    it("should extract hostname from URL with port", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      fetchMock.mockResolvedValue({ ok: true });

      const url = "http://localhost:8080/api";
      await applyNetworkIOGateAndFetch(url);

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "localhost",
        })
      );
    });

    it("should fallback to truncated URL on parsing error", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      fetchMock.mockResolvedValue({ ok: true });

      const invalidUrl = "not a valid url";
      await applyNetworkIOGateAndFetch(invalidUrl);

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          url: invalidUrl,
        })
      );
    });
  });

  describe("Gating Call Validation", () => {
    it("should call applyNetworkIOOverrides with correct stageId", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      fetchMock.mockResolvedValue({ ok: true });

      await applyNetworkIOGateAndFetch("https://api.example.com/test");

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "NETWORK_IO",
        })
      );
    });

    it("should call applyNetworkIOOverrides with userConfirmed false by default", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      fetchMock.mockResolvedValue({ ok: true });

      await applyNetworkIOGateAndFetch("https://api.example.com/test");

      expect(mockApplyNetworkIOOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          userConfirmed: false,
        })
      );
    });

    it("should call applyNetworkIOOverrides before fetch", async () => {
      const callOrder: string[] = [];
      
      mockApplyNetworkIOOverrides.mockImplementation(() => {
        callOrder.push("gate");
        return Promise.resolve({
          outcome: "PROCEED",
          contractId: null,
        });
      });
      fetchMock.mockImplementation(() => {
        callOrder.push("fetch");
        return Promise.resolve({ ok: true });
      });

      await applyNetworkIOGateAndFetch("https://api.example.com/test");

      expect(callOrder).toEqual(["gate", "fetch"]);
    });
  });

  describe("Error Handling", () => {
    it("should preserve fetch error if gate approves", async () => {
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      const fetchError = new Error("Network timeout");
      fetchMock.mockRejectedValue(fetchError);

      await expect(
        applyNetworkIOGateAndFetch("https://api.example.com/test")
      ).rejects.toBe(fetchError);
    });

    it("should handle gate throwing unexpected error", async () => {
      mockApplyNetworkIOOverrides.mockRejectedValue(new Error("Gate internal error"));
      fetchMock.mockResolvedValue({ ok: true });

      await expect(
        applyNetworkIOGateAndFetch("https://api.example.com/test")
      ).rejects.toThrow("Gate internal error");

      // Fetch should not be called if gate throws
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("Real-World Scenarios", () => {
    it("should handle OAuth token refresh with NETWORK_IO_BLOCKED", async () => {
      const tokenEndpoint = "https://github.com/login/oauth/access_token";
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NETWORK_OAUTH_TOKEN",
        instructions: "OAuth token refresh requires user confirmation",
      });

      try {
        await applyNetworkIOGateAndFetch(tokenEndpoint, {
          method: "POST",
          body: new URLSearchParams({ grant_type: "device_code" }),
        });
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as any).outcome).toBe("ABSTAIN_CONFIRM");
      }

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should handle API call with router uncertainty", async () => {
      const apiUrl = "https://api.example.com/data";
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId: "NETWORK_API_CALL",
        instructions: "Router uncertainty - cannot classify request",
      });

      await expect(
        applyNetworkIOGateAndFetch(apiUrl, { method: "GET" })
      ).rejects.toThrow(ClarityBurstAbstainError);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should allow approved simple GET request", async () => {
      const publicUrl = "https://api.example.com/public-data";
      const response = { ok: true, status: 200, json: async () => ({ data: "ok" }) };
      
      mockApplyNetworkIOOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NETWORK_GET_PUBLIC",
      });
      fetchMock.mockResolvedValue(response);

      const result = await applyNetworkIOGateAndFetch(publicUrl);

      expect(result).toBe(response);
      expect(fetchMock).toHaveBeenCalledWith(publicUrl, undefined);
    });
  });
});
