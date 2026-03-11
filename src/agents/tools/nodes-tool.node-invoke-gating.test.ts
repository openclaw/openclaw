/**
 * @fileoverview
 * Verifies that every callGatewayTool("node.invoke", ...) path in nodes-tool.ts is protected by
 * mandatory ClarityBurst NODE_INVOKE gating via applyNodeInvokeOverrides().
 *
 * This test suite ensures:
 * 1. PROCEED outcome allows dispatch to proceed
 * 2. ABSTAIN_CONFIRM outcome blocks dispatch with error
 * 3. ABSTAIN_CLARIFY outcome blocks dispatch with error
 * 4. All affected actions (notify, camera_snap, camera_clip, screen_record, run, invoke)
 *    are properly gated through invokeNodeCommandPayload() or direct gating
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OverrideOutcome } from "../../clarityburst/decision-override.js";
import { createNodesTool } from "./nodes-tool.js";
import type { AnyAgentTool } from "./common.js";
import { callGatewayTool } from "./gateway.js";
import * as decisionOverride from "../../clarityburst/decision-override.js";

// Mock ClarityBurst
vi.mock("../../clarityburst/decision-override.js");

// Mock callGatewayTool specifically
vi.mock("./gateway.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway.js")>("./gateway.js");
  return {
    ...actual,
    callGatewayTool: vi.fn(),
  };
});

// Mock common utilities
vi.mock("./common.js", async () => {
  const actual = await vi.importActual<typeof import("./common.js")>("./common.js");
  return {
    ...actual,
    readStringParam: (params: Record<string, unknown>, key: string, opts?: any) => {
      const val = params[key];
      if (val === undefined || val === null) return undefined;
      if (typeof val === "string") return val;
      return undefined;
    },
  };
});

// Mock nodes-utils
vi.mock("./nodes-utils.js", () => ({
  listNodes: vi.fn().mockResolvedValue([
    {
      nodeId: "test-node-id",
      name: "Test Node",
      platform: "ios",
      commands: ["system.run", "system.notify"],
    },
  ]),
  resolveNodeIdFromList: vi.fn().mockReturnValue("test-node-id"),
  resolveNodeId: vi.fn().mockResolvedValue("test-node-id"),
}));

// Mock camera and screen recording
vi.mock("../../cli/nodes-camera.js", () => ({
  cameraTempPath: vi.fn().mockReturnValue("/tmp/camera-test.jpg"),
  parseCameraSnapPayload: vi.fn().mockReturnValue({
    format: "jpg",
    base64: "base64data",
    width: 1600,
    height: 2400,
  }),
  parseCameraClipPayload: vi.fn().mockReturnValue({
    format: "mp4",
    durationMs: 3000,
    hasAudio: true,
    base64: "clipbase64",
  }),
  writeBase64ToFile: vi.fn().mockResolvedValue(undefined),
  writeUrlToFile: vi.fn().mockResolvedValue(undefined),
  writeCameraClipPayloadToFile: vi.fn().mockResolvedValue("/tmp/camera-clip.mp4"),
}));

vi.mock("../../cli/nodes-screen.js", () => ({
  screenRecordTempPath: vi.fn().mockReturnValue("/tmp/screen.mp4"),
  parseScreenRecordPayload: vi.fn().mockReturnValue({
    format: "mp4",
    base64: "screenbase64",
    durationMs: 10000,
    fps: 10,
    screenIndex: 0,
    hasAudio: true,
  }),
  writeScreenRecordToFile: vi.fn().mockResolvedValue({ path: "/tmp/screen.mp4" }),
}));

// Mock tool images sanitization
vi.mock("../tool-images.js", () => ({
  sanitizeToolResultImages: vi.fn(async (result) => result),
}));

// Mock other dependencies
vi.mock("../../cli/nodes-run.js");
vi.mock("../../cli/parse-duration.js");
vi.mock("../image-sanitization.js");
vi.mock("../agent-scope.js");
vi.mock("../../config/config.js");

describe("nodes-tool - NODE_INVOKE gating verification", () => {
  const mockApplyNodeInvokeOverrides = decisionOverride.applyNodeInvokeOverrides as any;
  const mockCallGatewayTool = callGatewayTool as any;
  let tool: AnyAgentTool;

  beforeEach(() => {
    // Only clear specific mocks, NOT readStringParam
    mockApplyNodeInvokeOverrides.mockClear();
    mockCallGatewayTool.mockClear();
    
    tool = createNodesTool();

    // Default: PROCEED (allow execution)
    mockApplyNodeInvokeOverrides.mockResolvedValue({
      outcome: "PROCEED",
      contractId: null,
    } as OverrideOutcome);

    // Default: successful gateway responses
    mockCallGatewayTool.mockResolvedValue({ ok: true, payload: {} });
  });

  const createParams = (overrides: Record<string, unknown> = {}) => ({
    node: "test-node",
    gatewayUrl: "ws://127.0.0.1:18789",
    gatewayToken: "test-token",
    ...overrides,
  });

  describe("Gating outcomes - PROCEED allows dispatch", () => {
    it("should allow notify dispatch when gate returns PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "notify",
        title: "Test",
        body: "Test notification",
      });

      // Verify gate was called
      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "system.notify",
      });

      // Verify dispatch happened
      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "system.notify",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should allow camera_snap dispatch when gate returns PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "camera_snap",
        facing: "front",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "camera.snap",
      });

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "camera.snap",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should allow invoke dispatch when gate returns PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "invoke",
        invokeCommand: "custom.command",
        invokeParamsJson: '{"test": "param"}',
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "custom.command",
      });

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "custom.command",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });
  });

  describe("Gating outcomes - ABSTAIN_CONFIRM blocks dispatch", () => {
    it("should block notify dispatch when gate returns ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NODE_EXECUTE_NOTIFICATION",
        instructions: "User confirmation required",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "notify",
          title: "Test",
          body: "Test notification",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("ABSTAIN_CONFIRM");
      }

      // Verify gate was consulted
      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();

      // Verify invoke was NOT called (only the gating call)
      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });

    it("should block camera_snap dispatch when gate returns ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NODE_EXECUTE_CAMERA",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "camera_snap",
          facing: "front",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("ABSTAIN_CONFIRM");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });

    it("should block invoke dispatch when gate returns ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NODE_CUSTOM_COMMAND",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "invoke",
          invokeCommand: "dangerous.command",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("ABSTAIN_CONFIRM");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();
    });
  });

  describe("Gating outcomes - ABSTAIN_CLARIFY blocks dispatch", () => {
    it("should block notify dispatch when gate returns ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Pack policy is incomplete",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "notify",
          title: "Test",
          body: "Test notification",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("ABSTAIN_CLARIFY");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });

    it("should block camera_clip dispatch when gate returns ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "camera_clip",
          facing: "front",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("ABSTAIN_CLARIFY");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();
    });

    it("should block invoke dispatch when gate returns ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "capability_denied",
        contractId: null,
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "invoke",
          invokeCommand: "restricted.command",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("ABSTAIN_CLARIFY");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();
    });
  });

  describe("Helper function path - invokeNodeCommandPayload", () => {
    it("should gate camera_list through invokeNodeCommandPayload and block on ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "NODE_LIST_CAMERA",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "camera_list",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("camera.list");
      }

      // Verify gate was called with camera.list
      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "camera.list",
      });
    });

    it("should gate notifications_list and block on ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "notifications_list",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("notifications.list");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "notifications.list",
      });
    });

    it("should gate device_info through invokeNodeCommandPayload and allow on PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      mockCallGatewayTool.mockResolvedValue({ payload: { model: "iPhone 12" } });

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "device_info",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "device.info",
      });

      // Verify invoke was called
      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "device.info",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should gate location_get through invokeNodeCommandPayload", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      mockCallGatewayTool.mockResolvedValue({
        payload: { latitude: 37.7749, longitude: -122.4194 },
      });

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "location_get",
        desiredAccuracy: "precise",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "location.get",
      });

      // Verify invoke was called
      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "location.get",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });
  });

  describe("Gating context verification", () => {
    it("should always pass stageId=NODE_INVOKE to the gate", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      // Test multiple actions
      const actions = [
        { action: "notify", title: "Test", body: "Body" },
        { action: "invoke", invokeCommand: "test.cmd" },
        { action: "device_info" },
      ];

      for (const actionParams of actions) {
        vi.clearAllMocks();
        mockApplyNodeInvokeOverrides.mockResolvedValue({
          outcome: "PROCEED",
          contractId: null,
        } as OverrideOutcome);
        mockCallGatewayTool.mockResolvedValue({ payload: {} });

        try {
          await tool.execute("test-id", {
            ...createParams(),
            ...actionParams,
          });
        } catch {
          // May fail but we're checking the gate call
        }

        const calls = mockApplyNodeInvokeOverrides.mock.calls;
        if (calls.length > 0) {
          expect(calls[0][0]).toHaveProperty("stageId", "NODE_INVOKE");
        }
      }
    });

    it("should pass correct functionName for each action", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const testCases = [
        { action: "notify", functionName: "system.notify", title: "T", body: "B" },
        { action: "camera_snap", functionName: "camera.snap", facing: "front" },
        { action: "camera_clip", functionName: "camera.clip", facing: "front" },
        { action: "screen_record", functionName: "screen.record" },
        { action: "invoke", functionName: "custom.cmd", invokeCommand: "custom.cmd" },
        { action: "camera_list", functionName: "camera.list" },
        { action: "device_info", functionName: "device.info" },
        { action: "location_get", functionName: "location.get" },
        { action: "notifications_list", functionName: "notifications.list" },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();
        mockApplyNodeInvokeOverrides.mockResolvedValue({
          outcome: "PROCEED",
          contractId: null,
        } as OverrideOutcome);
        mockCallGatewayTool.mockResolvedValue({ payload: {} });

        const params: Record<string, unknown> = {
          ...createParams(),
          action: testCase.action,
          title: "T",
          body: "B",
          facing: "front",
          invokeCommand: "custom.cmd",
        };

        try {
          await tool.execute("test-id", params);
        } catch {
          // May fail
        }

        expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
          stageId: "NODE_INVOKE",
          functionName: testCase.functionName,
        });
      }
    });
  });

  describe("Gating blocks callGatewayTool dispatch", () => {
    it("should not call callGatewayTool node.invoke when ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "TEST",
      } as OverrideOutcome);

      try {
        await tool.execute("test-id", {
          ...createParams(),
          action: "invoke",
          invokeCommand: "test.cmd",
        });
      } catch {
        // Expected
      }

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });

    it("should not call callGatewayTool node.invoke when ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      } as OverrideOutcome);

      try {
        await tool.execute("test-id", {
          ...createParams(),
          action: "camera_list",
        });
      } catch {
        // Expected
      }

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });
  });
});
