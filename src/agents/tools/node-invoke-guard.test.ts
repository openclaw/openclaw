/**
 * @fileoverview
 * Unit tests for node-invoke-guard helper
 *
 * Verifies that dispatchNodeInvokeGuarded:
 * 1. Calls applyNodeInvokeOverrides with stageId: "NODE_INVOKE"
 * 2. PROCEED outcome dispatches to callGatewayTool("node.invoke", ...)
 * 3. ABSTAIN_CONFIRM outcome blocks dispatch with error
 * 4. ABSTAIN_CLARIFY outcome blocks dispatch with error
 * 5. Passes correct NODE_INVOKE context to gating function
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dispatchNodeInvokeGuarded,
  type NodeInvokeParams,
  type NodeInvokeGatewayOpts,
} from "./node-invoke-guard.js";
import * as decisionOverride from "../../clarityburst/decision-override.js";
import * as gatewayTool from "./gateway.js";

// Mock the dependencies
vi.mock("../../clarityburst/decision-override.js");
vi.mock("./gateway.js");

const mockApplyNodeInvokeOverrides = vi.mocked(decisionOverride.applyNodeInvokeOverrides);
const mockCallGatewayTool = vi.mocked(gatewayTool.callGatewayTool);

describe("dispatchNodeInvokeGuarded", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("PROCEED outcome", () => {
    it("should dispatch to callGatewayTool when NODE_INVOKE gating returns PROCEED", async () => {
      // Arrange: Gating allows execution
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NODE_INVOKE_SYSTEM_RUN",
      });

      const mockResponse = { payload: { success: true } };
      mockCallGatewayTool.mockResolvedValue(mockResponse);

      // Act: Dispatch with valid parameters
      const params: NodeInvokeParams = {
        nodeId: "test-node-1",
        command: "system.run",
        params: { cmd: "echo hello" },
        idempotencyKey: "test-key",
      };
      const gatewayOpts: NodeInvokeGatewayOpts = { timeoutMs: 30000 };

      const result = await dispatchNodeInvokeGuarded(
        "system.run",
        "test-node-1",
        params,
        gatewayOpts,
      );

      // Assert: callGatewayTool was called with correct arguments
      expect(mockCallGatewayTool).toHaveBeenCalledWith(
        "node.invoke",
        gatewayOpts,
        params,
      );
      expect(result).toEqual(mockResponse);
    });

    it("should pass correct NODE_INVOKE context to applyNodeInvokeOverrides", async () => {
      // Arrange
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NODE_INVOKE_BROWSER_PROXY",
      });
      mockCallGatewayTool.mockResolvedValue({ payload: {} });

      // Act
      const params: NodeInvokeParams = {
        nodeId: "browser-node",
        command: "browser.proxy",
        params: { method: "GET", path: "/test" },
      };
      await dispatchNodeInvokeGuarded(
        "browser.proxy",
        "browser-node",
        params,
        { timeoutMs: 20000 },
      );

      // Assert: Verify gating was called with stageId: "NODE_INVOKE" and functionName
      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "NODE_INVOKE",
          functionName: "browser.proxy",
        }),
      );
    });

    it("should include additionalContext in gating call when provided", async () => {
      // Arrange
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      mockCallGatewayTool.mockResolvedValue({ payload: {} });

      // Act
      const params: NodeInvokeParams = {
        nodeId: "test-node",
        command: "system.run",
      };
      const additionalContext = {
        userConfirmed: true,
        customField: "custom-value",
      };
      await dispatchNodeInvokeGuarded(
        "system.run",
        "test-node",
        params,
        {},
        additionalContext,
      );

      // Assert: Verify additionalContext was merged into the gating call
      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "NODE_INVOKE",
          functionName: "system.run",
          userConfirmed: true,
          customField: "custom-value",
        }),
      );
    });
  });

  describe("ABSTAIN_CONFIRM outcome", () => {
    it("should block dispatch when NODE_INVOKE gating returns ABSTAIN_CONFIRM", async () => {
      // Arrange: Gating denies with confirmation required
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NODE_INVOKE_CAMERA_SNAP",
        instructions: "User confirmation required for camera access",
      });

      // Act & Assert: Should throw error
      const params: NodeInvokeParams = {
        nodeId: "ios-node",
        command: "camera.snap",
      };

      await expect(
        dispatchNodeInvokeGuarded("camera.snap", "ios-node", params, {}),
      ).rejects.toThrow("node.invoke gated (ABSTAIN_CONFIRM)");

      // Assert: callGatewayTool should NOT be called
      expect(mockCallGatewayTool).not.toHaveBeenCalledWith(
        "node.invoke",
        expect.any(Object),
      );
    });

    it("should include reason and instructions in error message", async () => {
      // Arrange
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NODE_INVOKE_SYSTEM_RUN",
        instructions: "Dangerous operation requires explicit confirmation",
      });

      // Act & Assert
      const params: NodeInvokeParams = {
        nodeId: "test-node",
        command: "system.run",
      };

      try {
        await dispatchNodeInvokeGuarded("system.run", "test-node", params, {});
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error;
        expect(error.message).toContain("ABSTAIN_CONFIRM");
        expect(error.message).toContain("system.run");
        expect(error.message).toContain("CONFIRM_REQUIRED");
        expect(error.message).toContain("Dangerous operation");
      }
    });
  });

  describe("ABSTAIN_CLARIFY outcome", () => {
    it("should block dispatch when NODE_INVOKE gating returns ABSTAIN_CLARIFY", async () => {
      // Arrange: Gating denies with clarification needed
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId: null,
      });

      // Act & Assert: Should throw error
      const params: NodeInvokeParams = {
        nodeId: "test-node",
        command: "unknown.command",
      };

      await expect(
        dispatchNodeInvokeGuarded("unknown.command", "test-node", params, {}),
      ).rejects.toThrow("node.invoke gated (ABSTAIN_CLARIFY)");

      // Assert: callGatewayTool should NOT be called
      expect(mockCallGatewayTool).not.toHaveBeenCalledWith(
        "node.invoke",
        expect.any(Object),
      );
    });

    it("should handle router outage with ABSTAIN_CLARIFY", async () => {
      // Arrange
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
        instructions: "Router unavailable. Retry later.",
      });

      // Act & Assert
      const params: NodeInvokeParams = {
        nodeId: "node-1",
        command: "system.run",
      };

      try {
        await dispatchNodeInvokeGuarded("system.run", "node-1", params, {});
        throw new Error("Should have thrown");
      } catch (err) {
        const error = err as Error;
        expect(error.message).toContain("ABSTAIN_CLARIFY");
        expect(error.message).toContain("router_outage");
      }
    });

    it("should handle pack policy incomplete with ABSTAIN_CLARIFY", async () => {
      // Arrange
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "NODE_INVOKE pack missing thresholds",
      });

      // Act & Assert
      const params: NodeInvokeParams = {
        nodeId: "test-node",
        command: "system.run",
      };

      await expect(
        dispatchNodeInvokeGuarded("system.run", "test-node", params, {}),
      ).rejects.toThrow("PACK_POLICY_INCOMPLETE");

      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });
  });

  describe("Node context coverage", () => {
    it("should document stageId is always NODE_INVOKE", async () => {
      /**
       * CRITICAL: stageId MUST always be "NODE_INVOKE" when calling applyNodeInvokeOverrides.
       * This ensures the correct ClarityBurst stage is enforced.
       */
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      mockCallGatewayTool.mockResolvedValue({});

      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "cmd",
      };

      await dispatchNodeInvokeGuarded("cmd", "node", params, {});

      // Verify stageId is "NODE_INVOKE"
      const callArgs = mockApplyNodeInvokeOverrides.mock.calls[0][0];
      expect(callArgs.stageId).toBe("NODE_INVOKE");
    });

    it("should pass functionName from caller to gating context", async () => {
      /**
       * CRITICAL: functionName is passed directly from the caller to gating.
       * This is used by the router to determine which contract to apply.
       */
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      mockCallGatewayTool.mockResolvedValue({});

      const testCases = [
        "system.run",
        "camera.snap",
        "browser.proxy",
        "screen.record",
      ];

      for (const functionName of testCases) {
        vi.clearAllMocks();
        mockApplyNodeInvokeOverrides.mockResolvedValue({
          outcome: "PROCEED",
          contractId: null,
        });
        mockCallGatewayTool.mockResolvedValue({});

        const params: NodeInvokeParams = {
          nodeId: "test-node",
          command: functionName,
        };

        await dispatchNodeInvokeGuarded(functionName, "test-node", params, {});

        const callArgs = mockApplyNodeInvokeOverrides.mock.calls[0][0];
        expect(callArgs.functionName).toBe(functionName);
      }
    });
  });

  describe("Gateway dispatch integrity", () => {
    it("should pass nodeId and command correctly to gateway", async () => {
      // Arrange
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      mockCallGatewayTool.mockResolvedValue({ payload: "data" });

      // Act
      const params: NodeInvokeParams = {
        nodeId: "specific-node-123",
        command: "system.run",
        params: { cmd: "test" },
        idempotencyKey: "key-456",
      };
      const gatewayOpts: NodeInvokeGatewayOpts = { timeoutMs: 45000 };

      await dispatchNodeInvokeGuarded(
        "system.run",
        "specific-node-123",
        params,
        gatewayOpts,
      );

      // Assert: Verify exact parameters passed to gateway
      expect(mockCallGatewayTool).toHaveBeenCalledWith(
        "node.invoke",
        { timeoutMs: 45000 },
        {
          nodeId: "specific-node-123",
          command: "system.run",
          params: { cmd: "test" },
          idempotencyKey: "key-456",
        },
      );
    });

    it("should return gateway response without modification", async () => {
      // Arrange
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });

      const complexResponse = {
        payload: {
          success: true,
          stdout: "output",
          stderr: "error",
          exitCode: 0,
        },
        metadata: { version: 2 },
      };
      mockCallGatewayTool.mockResolvedValue(complexResponse);

      // Act
      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "system.run",
      };
      const result = await dispatchNodeInvokeGuarded("system.run", "node", params, {});

      // Assert: Response should be returned exactly as from gateway
      expect(result).toEqual(complexResponse);
    });
  });

  describe("Error handling", () => {
    it("should propagate unexpected gating exceptions", async () => {
      // Arrange
      const unexpectedError = new Error("Unexpected gating error");
      mockApplyNodeInvokeOverrides.mockRejectedValue(unexpectedError);

      // Act & Assert
      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "cmd",
      };

      await expect(
        dispatchNodeInvokeGuarded("cmd", "node", params, {}),
      ).rejects.toThrow("Unexpected gating error");

      // Verify gateway was never called
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });

    it("should propagate gateway errors when gating allows", async () => {
      // Arrange
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      const gatewayError = new Error("Gateway connection timeout");
      mockCallGatewayTool.mockRejectedValue(gatewayError);

      // Act & Assert
      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "cmd",
      };

      await expect(
        dispatchNodeInvokeGuarded("cmd", "node", params, {}),
      ).rejects.toThrow("Gateway connection timeout");
    });
  });

  describe("Identity field hardening", () => {
    it("should prevent additionalContext from overriding stageId", async () => {
      /**
       * SECURITY: additionalContext CANNOT override the mandatory stageId.
       * Even if additionalContext.stageId is provided, it MUST be ignored.
       * The implementation applies identity fields AFTER spreading additionalContext
       * to enforce this invariant.
       */
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      mockCallGatewayTool.mockResolvedValue({});

      // Act: Provide additionalContext with malicious stageId
      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "cmd",
      };
      const maliciousContext = {
        stageId: "SHELL_EXEC",  // Try to override to a different stage
      };

      await dispatchNodeInvokeGuarded("cmd", "node", params, {}, maliciousContext);

      // Assert: Verify that stageId is still "NODE_INVOKE" in the gating call
      const contextArg = mockApplyNodeInvokeOverrides.mock.calls[0][0];
      expect(contextArg.stageId).toBe("NODE_INVOKE");
      expect(contextArg.stageId).not.toBe("SHELL_EXEC");
    });

    it("should prevent additionalContext from overriding functionName", async () => {
      /**
       * SECURITY: additionalContext CANNOT override the functionName.
       * The explicit function argument is the source of truth.
       * Even if additionalContext.functionName differs, the explicit arg wins.
       */
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      mockCallGatewayTool.mockResolvedValue({});

      // Act: Provide additionalContext with different functionName
      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "system.run",
      };
      const maliciousContext = {
        functionName: "camera.snap",  // Try to override the function name
      };

      await dispatchNodeInvokeGuarded(
        "system.run",  // Explicit function argument
        "node",
        params,
        {},
        maliciousContext,
      );

      // Assert: Verify functionName is still the explicit argument value
      const contextArg = mockApplyNodeInvokeOverrides.mock.calls[0][0];
      expect(contextArg.functionName).toBe("system.run");
      expect(contextArg.functionName).not.toBe("camera.snap");
    });

    it("should allow additionalContext for non-identity fields", async () => {
      /**
       * Non-identity fields in additionalContext should be passed through.
       * Only stageId and functionName are protected from override.
       */
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      });
      mockCallGatewayTool.mockResolvedValue({});

      // Act
      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "cmd",
      };
      const additionalContext = {
        userConfirmed: true,
        customField: "custom-value",
        customNumber: 42,
      };

      await dispatchNodeInvokeGuarded(
        "cmd",
        "node",
        params,
        {},
        additionalContext,
      );

      // Assert: Verify non-identity fields are included
      const contextArg = mockApplyNodeInvokeOverrides.mock.calls[0][0];
      expect(contextArg.userConfirmed).toBe(true);
      expect(contextArg.customField).toBe("custom-value");
      expect(contextArg.customNumber).toBe(42);
    });

    it("should maintain existing PROCEED behavior with identity hardening", async () => {
      /**
       * Verify that hardening identity fields does not break existing PROCEED behavior.
       * Gateway dispatch should still work correctly with hardened context.
       */
      const expectedResponse = { payload: { result: "success" } };
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "NODE_INVOKE_SYSTEM_RUN",
      });
      mockCallGatewayTool.mockResolvedValue(expectedResponse);

      // Act
      const params: NodeInvokeParams = {
        nodeId: "test-node",
        command: "system.run",
        params: { cmd: "test" },
      };
      const additionalContext = {
        stageId: "SHOULD_BE_IGNORED",
        functionName: "SHOULD_BE_IGNORED",
        userConfirmed: true,
      };

      const result = await dispatchNodeInvokeGuarded(
        "system.run",
        "test-node",
        params,
        { timeoutMs: 30000 },
        additionalContext,
      );

      // Assert
      expect(result).toEqual(expectedResponse);
      expect(mockCallGatewayTool).toHaveBeenCalledWith(
        "node.invoke",
        { timeoutMs: 30000 },
        params,
      );
    });

    it("should maintain existing ABSTAIN_CONFIRM behavior with identity hardening", async () => {
      /**
       * Verify that hardening does not break ABSTAIN_CONFIRM blocking behavior.
       */
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NODE_INVOKE_SYSTEM_RUN",
      });

      // Act & Assert
      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "system.run",
      };
      const additionalContext = {
        stageId: "ATTACK_STAGE",
        functionName: "attack.func",
      };

      await expect(
        dispatchNodeInvokeGuarded(
          "system.run",
          "node",
          params,
          {},
          additionalContext,
        ),
      ).rejects.toThrow("ABSTAIN_CONFIRM");

      // Gateway should never be called
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });

    it("should maintain existing ABSTAIN_CLARIFY behavior with identity hardening", async () => {
      /**
       * Verify that hardening does not break ABSTAIN_CLARIFY blocking behavior.
       */
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      // Act & Assert
      const params: NodeInvokeParams = {
        nodeId: "node",
        command: "cmd",
      };
      const additionalContext = {
        stageId: "ATTACK_STAGE",
        functionName: "attack.func",
      };

      await expect(
        dispatchNodeInvokeGuarded(
          "cmd",
          "node",
          params,
          {},
          additionalContext,
        ),
      ).rejects.toThrow("ABSTAIN_CLARIFY");

      // Gateway should never be called
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
    });
  });
});
