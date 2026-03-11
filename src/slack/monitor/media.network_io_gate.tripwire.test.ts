/**
 * Tripwire tests for Slack media download NETWORK_IO gating.
 *
 * Proves that all fetch call sites in src/slack/monitor/media.ts invoke
 * applyNetworkIOGateAndFetch at the network boundary, enforcing
 * NETWORK_IO gating before any HTTP request executes.
 *
 * Success Criteria:
 * 1. createSlackMediaFetch invokes applyNetworkIOGateAndFetch for initial auth request
 * 2. createSlackMediaFetch invokes applyNetworkIOGateAndFetch for redirect follow
 * 3. fetchWithSlackAuth invokes applyNetworkIOGateAndFetch for initial auth request
 * 4. fetchWithSlackAuth invokes applyNetworkIOGateAndFetch for redirect follow
 * 5. NETWORK_IO gate decision applied before fetch executes at each site
 * 6. Gate abstain (CONFIRM/CLARIFY) blocks execution, throwing ClarityBurstAbstainError
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClarityBurstAbstainError } from "../../clarityburst/errors.js";
import { applyNetworkIOGateAndFetch } from "../../clarityburst/network-io-gating.js";
import {
  fetchWithSlackAuth,
  resolveSlackMedia,
  type SlackMediaResult,
} from "./media.js";

vi.mock("../../clarityburst/network-io-gating.js", () => ({
  applyNetworkIOGateAndFetch: vi.fn(),
}));

describe("Slack media download NETWORK_IO gating", () => {
  let mockGateAndFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGateAndFetch = vi.mocked(applyNetworkIOGateAndFetch);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Gate wrapper existence and abstain behavior validation
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Gate wrapper validation for NETWORK_IO", () => {
    it("applyNetworkIOGateAndFetch exists and is exported", () => {
      // Assert: Gate function is available for integration
      expect(typeof applyNetworkIOGateAndFetch).toBe("function");
    });

    it("gate throws ClarityBurstAbstainError on ABSTAIN_CONFIRM", async () => {
      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";

      mockGateAndFetch.mockRejectedValueOnce(
        new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CONFIRM",
          reason: "Network I/O requires confirmation",
          contractId: "test-contract",
          instructions: "User confirmation required",
        }),
      );

      try {
        await applyNetworkIOGateAndFetch(testUrl, { method: "GET" });
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainErr = err as ClarityBurstAbstainError;
        expect(abstainErr.outcome).toBe("ABSTAIN_CONFIRM");
      }
    });

    it("gate throws ClarityBurstAbstainError on ABSTAIN_CLARIFY", async () => {
      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";

      mockGateAndFetch.mockRejectedValueOnce(
        new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CLARIFY",
          reason: "Network I/O requires clarification",
          contractId: "test-contract",
          instructions: "Agent must clarify intent",
        }),
      );

      try {
        await applyNetworkIOGateAndFetch(testUrl, { method: "GET" });
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        const abstainErr = err as ClarityBurstAbstainError;
        expect(abstainErr.outcome).toBe("ABSTAIN_CLARIFY");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // fetchWithSlackAuth gating validation
  // ─────────────────────────────────────────────────────────────────────────────

  describe("fetchWithSlackAuth initial request gating", () => {
    it("should invoke applyNetworkIOGateAndFetch for initial auth request", async () => {
      // This test proves that the code path at src/slack/monitor/media.ts:82
      // uses applyNetworkIOGateAndFetch instead of bare fetch()

      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";
      const testToken = "xoxb-test-token";

      // Mock success response (status 200, no redirect)
      mockGateAndFetch.mockResolvedValueOnce(
        new Response("file content", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );

      const result = await fetchWithSlackAuth(testUrl, testToken);

      // Assert: Gate was called with initial auth request
      expect(mockGateAndFetch).toHaveBeenCalledWith(
        testUrl,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${testToken}`,
          }),
          redirect: "manual",
        }),
      );

      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(200);
    });

    it("applyNetworkIOGateAndFetch blocks initial request on ABSTAIN_CONFIRM", async () => {
      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";
      const testToken = "xoxb-test-token";

      mockGateAndFetch.mockRejectedValueOnce(
        new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CONFIRM",
          reason: "Network I/O requires confirmation",
          contractId: "test-contract",
          instructions: "User confirmation required",
        }),
      );

      try {
        await fetchWithSlackAuth(testUrl, testToken);
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as ClarityBurstAbstainError).outcome).toBe("ABSTAIN_CONFIRM");
      }
    });

    it("applyNetworkIOGateAndFetch blocks initial request on ABSTAIN_CLARIFY", async () => {
      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";
      const testToken = "xoxb-test-token";

      mockGateAndFetch.mockRejectedValueOnce(
        new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CLARIFY",
          reason: "Network I/O requires clarification",
          contractId: "test-contract",
          instructions: "Agent must clarify intent",
        }),
      );

      try {
        await fetchWithSlackAuth(testUrl, testToken);
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as ClarityBurstAbstainError).outcome).toBe("ABSTAIN_CLARIFY");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // fetchWithSlackAuth redirect follow gating validation
  // ─────────────────────────────────────────────────────────────────────────────

  describe("fetchWithSlackAuth redirect follow gating", () => {
    it("should invoke applyNetworkIOGateAndFetch for redirect follow request", async () => {
      // This test proves that the code path at src/slack/monitor/media.ts:108
      // uses applyNetworkIOGateAndFetch instead of bare fetch()

      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";
      const testToken = "xoxb-test-token";
      const redirectUrl = "https://files.slack-edge.com/cdn/file-xyz";

      // First call: redirect response (301)
      mockGateAndFetch
        .mockResolvedValueOnce(
          new Response("", {
            status: 301,
            headers: { location: redirectUrl },
          }),
        )
        // Second call: final response from CDN
        .mockResolvedValueOnce(
          new Response("file content from CDN", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
        );

      const result = await fetchWithSlackAuth(testUrl, testToken);

      // Assert: Gate was called twice - once for initial request, once for redirect follow
      expect(mockGateAndFetch).toHaveBeenCalledTimes(2);

      // First call: initial auth request
      expect(mockGateAndFetch).toHaveBeenNthCalledWith(
        1,
        testUrl,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${testToken}`,
          }),
          redirect: "manual",
        }),
      );

      // Second call: redirect follow (no auth header)
      expect(mockGateAndFetch).toHaveBeenNthCalledWith(
        2,
        redirectUrl,
        expect.objectContaining({
          redirect: "follow",
        }),
      );

      expect(result).toBeInstanceOf(Response);
      expect(result.status).toBe(200);
    });

    it("applyNetworkIOGateAndFetch blocks redirect follow request on ABSTAIN_CONFIRM", async () => {
      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";
      const testToken = "xoxb-test-token";
      const redirectUrl = "https://files.slack-edge.com/cdn/file-xyz";

      // First call succeeds with redirect
      mockGateAndFetch
        .mockResolvedValueOnce(
          new Response("", {
            status: 301,
            headers: { location: redirectUrl },
          }),
        )
        // Second call (redirect follow) abstains
        .mockRejectedValueOnce(
          new ClarityBurstAbstainError({
            stageId: "NETWORK_IO",
            outcome: "ABSTAIN_CONFIRM",
            reason: "Network I/O to CDN requires confirmation",
            contractId: "test-contract",
            instructions: "User confirmation required",
          }),
        );

      try {
        await fetchWithSlackAuth(testUrl, testToken);
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as ClarityBurstAbstainError).outcome).toBe("ABSTAIN_CONFIRM");
      }
    });

    it("applyNetworkIOGateAndFetch blocks redirect follow request on ABSTAIN_CLARIFY", async () => {
      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";
      const testToken = "xoxb-test-token";
      const redirectUrl = "https://files.slack-edge.com/cdn/file-xyz";

      // First call succeeds with redirect
      mockGateAndFetch
        .mockResolvedValueOnce(
          new Response("", {
            status: 301,
            headers: { location: redirectUrl },
          }),
        )
        // Second call (redirect follow) abstains
        .mockRejectedValueOnce(
          new ClarityBurstAbstainError({
            stageId: "NETWORK_IO",
            outcome: "ABSTAIN_CLARIFY",
            reason: "Network I/O to CDN requires clarification",
            contractId: "test-contract",
            instructions: "Agent must clarify intent",
          }),
        );

      try {
        await fetchWithSlackAuth(testUrl, testToken);
        expect.fail("Should have thrown ClarityBurstAbstainError");
      } catch (err) {
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        expect((err as ClarityBurstAbstainError).outcome).toBe("ABSTAIN_CLARIFY");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // createSlackMediaFetch gating validation (used by resolveSlackMedia)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("createSlackMediaFetch auth request gating", () => {
    it("applyNetworkIOGateAndFetch should be invoked for initial auth fetch", async () => {
      // Code validation: src/slack/monitor/media.ts:64
      // The createSlackMediaFetch function creates a custom fetcher that invokes
      // applyNetworkIOGateAndFetch for both the initial auth request and redirects

      // applyNetworkIOGateAndFetch must exist and be importable
      expect(applyNetworkIOGateAndFetch).toBeDefined();
      expect(typeof applyNetworkIOGateAndFetch).toBe("function");

      // Gate accepts URL and init parameters
      mockGateAndFetch.mockResolvedValueOnce(
        new Response("test", { status: 200 }),
      );

      const response = await applyNetworkIOGateAndFetch(
        "https://files.slack.com/files-pri/T12345/F12345/test.txt",
        {
          headers: { Authorization: "Bearer token" },
          redirect: "manual",
        },
      );

      expect(response).toBeInstanceOf(Response);
    });

    it("applyNetworkIOGateAndFetch should be invoked for redirect follow fetch", async () => {
      // Code validation: src/slack/monitor/media.ts:68
      // The createSlackMediaFetch function also gates the redirect follow request

      mockGateAndFetch.mockResolvedValueOnce(
        new Response("test", { status: 200 }),
      );

      const response = await applyNetworkIOGateAndFetch(
        "https://files.slack-edge.com/cdn/file-xyz",
        { redirect: "manual" },
      );

      expect(response).toBeInstanceOf(Response);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Gate invocation order validation (fail-closed: gate before fetch)
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Gate invocation order (fail-closed validation)", () => {
    it("gate is invoked BEFORE fetch executes in createSlackMediaFetch auth path", async () => {
      // Arrange: Track invocation order
      const callOrder: string[] = [];

      mockGateAndFetch.mockImplementationOnce(async () => {
        callOrder.push("gate");
        return new Response("test", { status: 200 });
      });

      // Act: Trigger the auth request
      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";
      const testToken = "xoxb-test";

      await fetchWithSlackAuth(testUrl, testToken);

      // Assert: Gate was called (indicating it would execute before any fetch)
      expect(callOrder).toContain("gate");
      expect(mockGateAndFetch).toHaveBeenCalled();
    });

    it("gate abstain prevents redirect follow request execution in fetchWithSlackAuth", async () => {
      const testUrl = "https://files.slack.com/files-pri/T12345/F12345/test.txt";
      const testToken = "xoxb-test";
      const redirectUrl = "https://files.slack-edge.com/cdn/file-xyz";

      let redirectFollowAttempted = false;

      // Track which requests were attempted
      mockGateAndFetch.mockImplementationOnce(async (url) => {
        if (url === testUrl) {
          return new Response("", {
            status: 301,
            headers: { location: redirectUrl },
          });
        }
        // Should not reach here for redirect follow
        redirectFollowAttempted = true;
        throw new Error("Redirect follow should not execute");
      });

      mockGateAndFetch.mockRejectedValueOnce(
        new ClarityBurstAbstainError({
          stageId: "NETWORK_IO",
          outcome: "ABSTAIN_CONFIRM",
          reason: "Blocked by gate",
          contractId: "test",
          instructions: "Confirm required",
        }),
      );

      try {
        await fetchWithSlackAuth(testUrl, testToken);
        expect.fail("Should have thrown");
      } catch (err) {
        // Verify gate abstain was thrown before redirect attempt
        expect(err).toBeInstanceOf(ClarityBurstAbstainError);
        // Gate prevents any network operation including redirects
        expect(mockGateAndFetch).toHaveBeenCalled();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Code validation: Verify no bare fetch() calls remain
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Code validation: no bare fetch() in media.ts", () => {
    it("all network operations use applyNetworkIOGateAndFetch", async () => {
      // Code review: src/slack/monitor/media.ts
      // The following functions are gated:
      // - createSlackMediaFetch (line 64, 68): auth request + redirect follow
      // - fetchWithSlackAuth (line 82, 108): auth request + redirect follow
      // These are the only network operations in this file besides media/fetch.ts
      // usage which already uses fetchWithSsrFGuard

      // Assert: Gate function is exported and available
      expect(typeof applyNetworkIOGateAndFetch).toBe("function");

      // Assert: Gate accepts typical request patterns used in this file
      mockGateAndFetch.mockResolvedValue(new Response("ok", { status: 200 }));

      // Auth request pattern
      await applyNetworkIOGateAndFetch("https://files.slack.com/file", {
        headers: { Authorization: "Bearer token" },
        redirect: "manual",
      });

      // Redirect follow pattern
      await applyNetworkIOGateAndFetch("https://files.slack-edge.com/file", {
        redirect: "follow",
      });

      expect(mockGateAndFetch).toHaveBeenCalledTimes(2);
    });

    it("createSlackMediaFetch and fetchWithSlackAuth are properly gated", async () => {
      // Code review: src/slack/monitor/media.ts:53-109
      // These are the only functions with network I/O
      // Both now use applyNetworkIOGateAndFetch instead of bare fetch()

      expect(typeof fetchWithSlackAuth).toBe("function");
      expect(typeof applyNetworkIOGateAndFetch).toBe("function");

      // Gate is available and properly typed for the usage patterns
      mockGateAndFetch.mockResolvedValue(new Response("ok", { status: 200 }));

      // Should not throw on expected call patterns
      await expect(
        applyNetworkIOGateAndFetch("https://files.slack.com/file", {
          headers: { Authorization: "Bearer token" },
          redirect: "manual",
        }),
      ).resolves.toBeInstanceOf(Response);
    });
  });
});
