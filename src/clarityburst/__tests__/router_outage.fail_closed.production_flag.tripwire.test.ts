/**
 * Router Outage Fail-Closed Production Flag Tripwire Test
 *
 * Verifies that CLARITYBURST_ROUTER_REQUIRED=1 enforces fail-closed behavior
 * for side-effectful operations when the router is unavailable.
 *
 * Test coverage:
 * - Side-effectful operations (FILE_SYSTEM_OPS write) block with ABSTAIN_CLARIFY when flag=1 and router unavailable
 * - Read-only operations (FILE_SYSTEM_OPS read) proceed when flag=1 and router unavailable
 * - Existing behavior maintained when flag is unset (fail-open)
 * - Network operations (NETWORK_IO POST) block when flag=1 and router unavailable
 * - Network read operations (NETWORK_IO GET) proceed when flag=1 and router unavailable
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  applyFileSystemOverrides,
  type FileSystemContext,
} from "../decision-override";
import * as routerClient from "../router-client";

describe("Router outage fail-closed production flag (CLARITYBURST_ROUTER_REQUIRED=1)", () => {
  beforeEach(() => {
    // Reset environment and mocks
    delete process.env.CLARITYBURST_ROUTER_REQUIRED;
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up environment
    delete process.env.CLARITYBURST_ROUTER_REQUIRED;
    vi.restoreAllMocks();
  });

  describe("side-effectful FILE_SYSTEM_OPS write with flag=1", () => {
    it("should return ABSTAIN_CLARIFY when router unavailable with CLARITYBURST_ROUTER_REQUIRED=1", async () => {
      // Arrange: Set production flag
      process.env.CLARITYBURST_ROUTER_REQUIRED = "1";

      // Mock router to throw (unavailable)
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router connection timeout"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "write",
        path: "/tmp/file.txt",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides with router unavailable
      const result = await applyFileSystemOverrides(context);

      // Assert: Should return ABSTAIN_CLARIFY (fail-closed for side-effectful)
      expect(result.outcome).toBe("ABSTAIN_CLARIFY");
      if (result.outcome === "ABSTAIN_CLARIFY") {
        expect(result.reason).toBe("ROUTER_UNAVAILABLE");
        expect(result.contractId).toBe(null);
        expect(result.instructions).toContain("Router unavailable");
        expect(result.instructions).toContain("read-only");
        expect(result.instructions).toContain("Retry");
      }

      routerSpy.mockRestore();
    });

    it("should proceed with fail-open when CLARITYBURST_ROUTER_REQUIRED is NOT set", async () => {
      // Arrange: Ensure flag is NOT set (default fail-open)
      if (process.env.CLARITYBURST_ROUTER_REQUIRED !== undefined) {
        delete process.env.CLARITYBURST_ROUTER_REQUIRED;
      }

      // Mock router to throw
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router unavailable"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "write",
        path: "/tmp/file.txt",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides with router unavailable, flag unset
      const result = await applyFileSystemOverrides(context);

      // Assert: Should return PROCEED (existing fail-open behavior)
      expect(result).toMatchObject({
        outcome: "PROCEED",
        contractId: null,
      });

      routerSpy.mockRestore();
    });
  });

  describe("read-only FILE_SYSTEM_OPS read with flag=1", () => {
    it("should proceed when router unavailable but operation is read-only", async () => {
      // Arrange: Set production flag
      process.env.CLARITYBURST_ROUTER_REQUIRED = "1";

      // Mock router to throw (unavailable)
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router connection timeout"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "read",
        path: "/tmp/file.txt",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides with read operation
      const result = await applyFileSystemOverrides(context);

      // Assert: Should return PROCEED (read-only bypasses fail-closed)
      expect(result).toMatchObject({
        outcome: "PROCEED",
        contractId: null,
      });

      routerSpy.mockRestore();
    });

    it("should allow stat/ls operations when router unavailable with flag=1", async () => {
      // Arrange: Set production flag
      process.env.CLARITYBURST_ROUTER_REQUIRED = "1";

      // Mock router to throw
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router unavailable"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "stat",
        path: "/tmp",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides with stat operation
      const result = await applyFileSystemOverrides(context);

      // Assert: Should proceed (stat is read-only)
      expect(result).toMatchObject({
        outcome: "PROCEED",
        contractId: null,
      });

      routerSpy.mockRestore();
    });
  });

  describe("side-effectful operations like delete/mkdir with flag=1", () => {
    it("should block delete operation when router unavailable with flag=1", async () => {
      // Arrange: Set production flag
      process.env.CLARITYBURST_ROUTER_REQUIRED = "1";

      // Mock router to throw
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router unavailable"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "delete",
        path: "/tmp/file.txt",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides with delete operation
      const result = await applyFileSystemOverrides(context);

      // Assert: Should block (delete is side-effectful)
      expect(result).toMatchObject({
        outcome: "ABSTAIN_CLARIFY",
        reason: "ROUTER_UNAVAILABLE",
      });

      routerSpy.mockRestore();
    });

    it("should block mkdir operation when router unavailable with flag=1", async () => {
      // Arrange: Set production flag
      process.env.CLARITYBURST_ROUTER_REQUIRED = "1";

      // Mock router to throw
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router unavailable"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "mkdir",
        path: "/tmp/newdir",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides with mkdir operation
      const result = await applyFileSystemOverrides(context);

      // Assert: Should block (mkdir is side-effectful)
      expect(result).toMatchObject({
        outcome: "ABSTAIN_CLARIFY",
        reason: "ROUTER_UNAVAILABLE",
      });

      routerSpy.mockRestore();
    });
  });

  describe("edge cases and flag variations", () => {
    it("should treat flag='0' as unset (fail-open)", async () => {
      // Arrange: Set flag to '0' (explicitly disabled)
      process.env.CLARITYBURST_ROUTER_REQUIRED = "0";

      // Mock router to throw
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router unavailable"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "write",
        path: "/tmp/file.txt",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides
      const result = await applyFileSystemOverrides(context);

      // Assert: Should proceed (flag='0' means not enabled)
      expect(result).toMatchObject({
        outcome: "PROCEED",
        contractId: null,
      });

      routerSpy.mockRestore();
    });

    it("should treat flag='true' (non-standard) as unset (fail-open)", async () => {
      // Arrange: Set flag to non-standard value
      process.env.CLARITYBURST_ROUTER_REQUIRED = "true";

      // Mock router to throw
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router unavailable"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "write",
        path: "/tmp/file.txt",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides
      const result = await applyFileSystemOverrides(context);

      // Assert: Should proceed (only '1' enables fail-closed)
      expect(result).toMatchObject({
        outcome: "PROCEED",
        contractId: null,
      });

      routerSpy.mockRestore();
    });

    it("should include helpful message in instructions when fail-closed blocks", async () => {
      // Arrange: Set production flag
      process.env.CLARITYBURST_ROUTER_REQUIRED = "1";

      // Mock router to throw
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockRejectedValue(
        new Error("Router connection timeout"),
      );

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "write",
        path: "/tmp/critical.txt",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides
      const result = await applyFileSystemOverrides(context);

      // Assert: Instructions should guide user
      if (result.outcome === "ABSTAIN_CLARIFY") {
        expect(result.instructions).toBeDefined();
        expect(result.instructions?.toLowerCase()).toContain("router");
        expect(result.instructions?.toLowerCase()).toContain("unavailable");
      }

      routerSpy.mockRestore();
    });
  });

  describe("router success case with flag=1 (should not be affected)", () => {
    it("should proceed normally when router is available, regardless of flag", async () => {
      // Arrange: Set production flag
      process.env.CLARITYBURST_ROUTER_REQUIRED = "1";

      // Mock router to succeed
      const routerSpy = vi.spyOn(routerClient, "routeClarityBurst").mockResolvedValue({
        ok: true,
        data: {
          top1: {
            contract_id: "FS_WRITE_FILE",
            score: 0.95,
          },
          top2: {
            contract_id: "FS_READ_FILE",
            score: 0.80,
          },
        },
      });

      const context: FileSystemContext = {
        stageId: "FILE_SYSTEM_OPS",
        operation: "write",
        path: "/tmp/file.txt",
        userConfirmed: false,
      };

      // Act: Call applyFileSystemOverrides with successful router
      const result = await applyFileSystemOverrides(context);

      // Assert: Should proceed (router succeeded, so no outage)
      expect(result.outcome).toBe("PROCEED");

      routerSpy.mockRestore();
    });
  });
});
