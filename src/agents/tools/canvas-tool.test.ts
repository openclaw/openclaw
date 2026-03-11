/**
 * Tests for canvas-tool.ts - verify blocked canvas invoke outcomes are properly propagated
 *
 * Tests that:
 * 1. All five actions (present, hide, navigate, a2ui_push, a2ui_reset) capture invoke() results
 * 2. Blocked responses (with ABSTAIN_* outcome) are properly propagated
 * 3. Success responses are returned only when invoke() actually succeeded
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCanvasTool } from "./canvas-tool.js";

// Mock the gateway tool
vi.mock("./gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({ gatewayUrl: "http://test" })),
}));

// Mock the applyNodeInvokeOverrides
vi.mock("../../clarityburst/decision-override.js", () => ({
  applyNodeInvokeOverrides: vi.fn(),
}));

// Mock other dependencies
vi.mock("../../cli/nodes-canvas.js", () => ({
  canvasSnapshotTempPath: vi.fn((opts: { ext: string }) => `/tmp/snapshot.${opts.ext}`),
  parseCanvasSnapshotPayload: vi.fn(() => ({
    format: "png",
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  })),
}));

vi.mock("../../cli/nodes-camera.js", () => ({
  writeBase64ToFile: vi.fn(),
}));

vi.mock("./nodes-utils.js", () => ({
  resolveNodeId: vi.fn(() => Promise.resolve("test-node-id")),
}));

vi.mock("../../media/inbound-path-policy.js", () => ({
  isInboundPathAllowed: vi.fn(() => true),
}));

vi.mock("../../media/local-roots.js", () => ({
  getDefaultMediaLocalRoots: vi.fn(() => ["/allowed/root"]),
}));

vi.mock("../../media/mime.js", () => ({
  imageMimeFromFormat: vi.fn(() => "image/png"),
}));

vi.mock("../image-sanitization.js", () => ({
  resolveImageSanitizationLimits: vi.fn(() => undefined),
}));

vi.mock("../tool-images.js", () => ({
  sanitizeToolResultImages: vi.fn(async (result) => result),
}));

import { callGatewayTool } from "./gateway.js";
import { applyNodeInvokeOverrides } from "../../clarityburst/decision-override.js";

type Details = Record<string, unknown>;

describe("canvas-tool - blocked response propagation", () => {
  const mockApplyNodeInvokeOverrides = applyNodeInvokeOverrides as any;
  const mockCallGatewayTool = callGatewayTool as any;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no blocking, allow proceed
    mockApplyNodeInvokeOverrides.mockResolvedValue({
      outcome: "PROCEED",
      contractId: null,
      reason: "ok",
    });
  });

  describe("present action", () => {
    it("should propagate blocked response when gate indicates ABSTAIN_CONFIRM", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
        outcome: "ABSTAIN_CONFIRM",
        contractId: "NODE_INVOKE_PRESENT",
        reason: "User confirmation required",
        instructions: "This action requires user confirmation",
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "present",
        target: "http://example.com",
      });

      // Assert: Result contains blocked response, not success
      const details = result?.details as Details;
      expect(details).toEqual({
        status: "blocked",
        outcome: "ABSTAIN_CONFIRM",
        contractId: "NODE_INVOKE_PRESENT",
        reason: "User confirmation required",
        instructions: "This action requires user confirmation",
        stageId: "NODE_INVOKE",
      });
      expect(details).not.toEqual({ ok: true });
    });

    it("should propagate blocked response when gate indicates ABSTAIN_CLARIFY", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
        outcome: "ABSTAIN_CLARIFY",
        contractId: null,
        reason: "Insufficient context",
        instructions: "Clarify intent",
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "present",
        target: "http://example.com",
      });

      // Assert: Result contains blocked response
      const details = result?.details as Details;
      expect(details.outcome).toBe("ABSTAIN_CLARIFY");
      expect(details.status).toBe("blocked");
      expect(details).not.toEqual({ ok: true });
    });

    it("should return success when invoke() succeeds", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockCallGatewayTool.mockResolvedValueOnce({ status: "ok" });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "present",
        target: "http://example.com",
      });

      // Assert: Result indicates success
      expect(result?.details).toEqual({ ok: true });
    });
  });

  describe("hide action", () => {
    it("should propagate blocked response when gate blocks", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
        outcome: "ABSTAIN_CONFIRM",
        contractId: "NODE_INVOKE_HIDE",
        reason: "Action blocked",
        instructions: "Cannot hide at this time",
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "hide",
      });

      // Assert: Result is blocked, not success
      const details = result?.details as Details;
      expect(details.status).toBe("blocked");
      expect(details.outcome).toBe("ABSTAIN_CONFIRM");
      expect(details).not.toEqual({ ok: true });
    });

    it("should return success when invoke() succeeds", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockCallGatewayTool.mockResolvedValueOnce({ status: "ok" });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "hide",
      });

      // Assert: Result indicates success
      expect(result?.details).toEqual({ ok: true });
    });
  });

  describe("navigate action", () => {
    it("should propagate blocked response when gate blocks", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
        outcome: "ABSTAIN_CLARIFY",
        contractId: null,
        reason: "URL policy violation",
        instructions: "URL must be from allowed domain",
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "navigate",
        url: "http://example.com",
      });

      // Assert: Result is blocked
      const details = result?.details as Details;
      expect(details.status).toBe("blocked");
      expect(details.outcome).toBe("ABSTAIN_CLARIFY");
      expect(details).not.toEqual({ ok: true });
    });

    it("should return success when invoke() succeeds", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockCallGatewayTool.mockResolvedValueOnce({ status: "ok" });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "navigate",
        url: "http://example.com",
      });

      // Assert: Result indicates success
      expect(result?.details).toEqual({ ok: true });
    });
  });

  describe("a2ui_push action", () => {
    it("should propagate blocked response when gate blocks", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
        outcome: "ABSTAIN_CONFIRM",
        contractId: "NODE_INVOKE_A2UI_PUSH",
        reason: "A2UI operation requires review",
        instructions: "Review UI modification request",
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "a2ui_push",
        jsonl: '{"action": "update"}',
      });

      // Assert: Result is blocked
      const details = result?.details as Details;
      expect(details.status).toBe("blocked");
      expect(details.outcome).toBe("ABSTAIN_CONFIRM");
      expect(details).not.toEqual({ ok: true });
    });

    it("should return success when invoke() succeeds", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockCallGatewayTool.mockResolvedValueOnce({ status: "ok" });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "a2ui_push",
        jsonl: '{"action": "update"}',
      });

      // Assert: Result indicates success
      expect(result?.details).toEqual({ ok: true });
    });

    it("should throw error when neither jsonl nor jsonlPath provided", async () => {
      // Arrange
      const tool = createCanvasTool();

      // Act & Assert
      await expect(
        tool.execute?.("test-call", {
          action: "a2ui_push",
        })
      ).rejects.toThrow("jsonl or jsonlPath required");
    });
  });

  describe("a2ui_reset action", () => {
    it("should propagate blocked response when gate blocks", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
        outcome: "ABSTAIN_CLARIFY",
        contractId: null,
        reason: "Cannot reset A2UI in current state",
        instructions: "Complete current operations first",
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "a2ui_reset",
      });

      // Assert: Result is blocked
      const details = result?.details as Details;
      expect(details.status).toBe("blocked");
      expect(details.outcome).toBe("ABSTAIN_CLARIFY");
      expect(details).not.toEqual({ ok: true });
    });

    it("should return success when invoke() succeeds", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockCallGatewayTool.mockResolvedValueOnce({ status: "ok" });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "a2ui_reset",
      });

      // Assert: Result indicates success
      expect(result?.details).toEqual({ ok: true });
    });
  });

  describe("eval action", () => {
    it("should propagate blocked response when gate blocks", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
        outcome: "ABSTAIN_CONFIRM",
        contractId: "NODE_INVOKE_EVAL",
        reason: "Code execution requires approval",
        instructions: "Review JavaScript code",
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "eval",
        javaScript: "console.log('test');",
      });

      // Assert: Result is blocked
      const details = result?.details as Details;
      expect(details.status).toBe("blocked");
      expect(details.outcome).toBe("ABSTAIN_CONFIRM");
      expect(details).not.toEqual({ ok: true });
    });

    it("should return result when eval succeeds", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockCallGatewayTool.mockResolvedValueOnce({
        details: { payload: { result: "test result" } },
        content: [{ type: "text", text: "test result" }],
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "eval",
        javaScript: "1 + 1",
      });

      // Assert: Result contains the evaluation output
      const details = result?.details as Details;
      expect(details.result).toBe("test result");
    });
  });

  describe("snapshot action", () => {
    it("should propagate blocked response when gate blocks", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
        outcome: "ABSTAIN_CLARIFY",
        contractId: null,
        reason: "Cannot capture snapshot",
        instructions: "Canvas not ready",
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "snapshot",
      });

      // Assert: Result is blocked
      const details = result?.details as Details;
      expect(details.status).toBe("blocked");
      expect(details.outcome).toBe("ABSTAIN_CLARIFY");
      expect(details).not.toEqual({ ok: true });
    });

    it("should return image result when snapshot succeeds", async () => {
      // Arrange
      const tool = createCanvasTool();
      mockCallGatewayTool.mockResolvedValueOnce({
        payload: {
          format: "png",
          base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      });

      // Act
      const result = await tool.execute?.("test-call", {
        action: "snapshot",
      });

      // Assert: Result is an image
      expect(result?.content).toBeDefined();
      expect(Array.isArray(result?.content)).toBe(true);
    });
  });

  describe("integration - all five critical actions propagate blocks correctly", () => {
    const actions = [
      { name: "present", params: { target: "http://test.com" } },
      { name: "hide", params: {} },
      { name: "navigate", params: { url: "http://test.com" } },
      { name: "a2ui_push", params: { jsonl: '{"test": true}' } },
      { name: "a2ui_reset", params: {} },
    ];

    it.each(actions)(
      "$name action should never return false-success on block",
      async ({ name, params }) => {
        // Arrange
        const tool = createCanvasTool();
        mockApplyNodeInvokeOverrides.mockResolvedValueOnce({
          outcome: "ABSTAIN_CONFIRM",
          contractId: `NODE_INVOKE_${name.toUpperCase()}`,
          reason: "Blocked by gate",
          instructions: "Request review",
        });

        // Act
        const result = await tool.execute?.("test-call", {
          action: name,
          ...params,
        });

        // Assert: CRITICAL - blocked responses are NOT reported as success
        const details = result?.details as Details;
        expect(details).not.toEqual({ ok: true });
        expect(details.status).toBe("blocked");
        expect(details.outcome).toBe("ABSTAIN_CONFIRM");
      }
    );
  });
});
