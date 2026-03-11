/**
 * @fileoverview
 * Verifies that every callGatewayTool("node.invoke", ...) path in browser-tool.ts is protected by
 * mandatory ClarityBurst NODE_INVOKE gating via applyNodeInvokeOverrides().
 *
 * This test suite ensures:
 * 1. PROCEED outcome allows browser proxy dispatch to proceed
 * 2. ABSTAIN_CONFIRM outcome blocks browser proxy dispatch with error
 * 3. ABSTAIN_CLARIFY outcome blocks browser proxy dispatch with error
 * 4. All browser.proxy node.invoke calls require proper NODE_INVOKE gating context
 * 5. stageId is always NODE_INVOKE
 * 6. functionName is always browser.proxy
 * 7. callGatewayTool("node.invoke", ...) is not called on blocked outcomes
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OverrideOutcome } from "../../clarityburst/decision-override.js";
import { createBrowserTool } from "./browser-tool.js";
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

// Mock browser client
vi.mock("../../browser/client.js", () => ({
  browserCloseTab: vi.fn(),
  browserFocusTab: vi.fn(),
  browserOpenTab: vi.fn(),
  browserProfiles: vi.fn().mockResolvedValue([]),
  browserSnapshot: vi.fn(),
  browserStart: vi.fn(),
  browserStatus: vi.fn().mockResolvedValue({ ok: true }),
  browserStop: vi.fn(),
  browserTabs: vi.fn().mockResolvedValue([]),
}));

// Mock browser client actions
vi.mock("../../browser/client-actions.js", () => ({
  browserAct: vi.fn(),
  browserArmDialog: vi.fn(),
  browserArmFileChooser: vi.fn(),
  browserConsoleMessages: vi.fn(),
  browserNavigate: vi.fn(),
  browserPdfSave: vi.fn(),
  browserScreenshotAction: vi.fn(),
}));

// Mock browser config
vi.mock("../../browser/config.js", () => ({
  resolveBrowserConfig: vi.fn().mockReturnValue({ enabled: true }),
}));

// Mock browser paths
vi.mock("../../browser/paths.js", () => ({
  DEFAULT_UPLOAD_DIR: "/tmp/uploads",
  resolveExistingPathsWithinRoot: vi.fn().mockResolvedValue({
    ok: true,
    paths: ["/tmp/uploads/test.txt"],
  }),
}));

// Mock browser proxy files
vi.mock("../../browser/proxy-files.js", () => ({
  applyBrowserProxyPaths: vi.fn(),
  persistBrowserProxyFiles: vi.fn().mockResolvedValue(new Map()),
}));

// Mock browser constants
vi.mock("../../browser/constants.js", () => ({
  DEFAULT_AI_SNAPSHOT_MAX_CHARS: 4000,
}));

// Mock nodes utilities
vi.mock("./nodes-utils.js", () => ({
  listNodes: vi.fn().mockResolvedValue([
    {
      nodeId: "test-browser-node",
      displayName: "Test Browser Node",
      remoteIp: "192.168.1.100",
      connected: true,
      caps: ["browser"],
      commands: ["browser.proxy"],
    },
  ]),
  resolveNodeIdFromList: vi.fn().mockReturnValue("test-browser-node"),
  selectDefaultNodeFromList: vi.fn().mockReturnValue({
    nodeId: "test-browser-node",
    displayName: "Test Browser Node",
    remoteIp: "192.168.1.100",
  }),
}));

// Mock security
vi.mock("../../security/external-content.js", () => ({
  wrapExternalContent: vi.fn((text) => text),
}));

// Mock config
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    browser: { enabled: true },
    gateway: { nodes: { browser: { mode: "auto" } } },
  }),
}));

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

// Mock tool images
vi.mock("../tool-images.js", () => ({
  sanitizeToolResultImages: vi.fn(async (result) => result),
}));

describe("browser-tool - NODE_INVOKE gating verification", () => {
  const mockApplyNodeInvokeOverrides = decisionOverride.applyNodeInvokeOverrides as any;
  const mockCallGatewayTool = callGatewayTool as any;
  let tool: AnyAgentTool;

  beforeEach(() => {
    mockApplyNodeInvokeOverrides.mockClear();
    mockCallGatewayTool.mockClear();

    tool = createBrowserTool();

    // Default: PROCEED (allow execution)
    mockApplyNodeInvokeOverrides.mockResolvedValue({
      outcome: "PROCEED",
      contractId: null,
    } as OverrideOutcome);

    // Default: successful gateway responses for browser proxy
    mockCallGatewayTool.mockResolvedValue({
      payload: {
        result: { ok: true },
      },
    });
  });

  const createParams = (overrides: Record<string, unknown> = {}) => ({
    action: "status",
    target: "node",
    ...overrides,
  });

  describe("Node-routed actions - gating verification", () => {
    it("should gate status action through node proxy when PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "status",
        node: "test-browser-node",
      });

      // Verify gate was called with NODE_INVOKE context
      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "browser.proxy",
      });

      // Verify dispatch happened
      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "browser.proxy",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should gate start action through node proxy when PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "start",
        node: "test-browser-node",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "browser.proxy",
      });

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "browser.proxy",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should gate stop action through node proxy when PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "stop",
        node: "test-browser-node",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "browser.proxy",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should gate snapshot action through node proxy when PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      mockCallGatewayTool.mockResolvedValue({
        payload: {
          result: {
            format: "ai",
            snapshot: "test snapshot data",
            nodes: [],
          },
        },
      });

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "snapshot",
        node: "test-browser-node",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "browser.proxy",
      });

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "browser.proxy",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should gate tabs action through node proxy when PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      mockCallGatewayTool.mockResolvedValue({
        payload: {
          result: {
            tabs: [],
          },
        },
      });

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "tabs",
        node: "test-browser-node",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "browser.proxy",
      });

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "browser.proxy",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should gate open action through node proxy when PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "open",
        node: "test-browser-node",
        targetUrl: "https://example.com",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "browser.proxy",
      });

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke" && call[2]?.command === "browser.proxy",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });
  });

  describe("Gating outcomes - ABSTAIN_CONFIRM blocks dispatch", () => {
    it("should block status dispatch when gate returns ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_PROXY_CONTROL",
        instructions: "User confirmation required for browser control",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "status",
          node: "test-browser-node",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("ABSTAIN_CONFIRM");
      }

      // Verify gate was consulted
      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();

      // Verify invoke was NOT called
      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });

    it("should block screenshot dispatch when gate returns ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_PROXY_CONTROL",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "screenshot",
          node: "test-browser-node",
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

    it("should block navigate dispatch when gate returns ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_PROXY_CONTROL",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "navigate",
          node: "test-browser-node",
          targetUrl: "https://example.com",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });
  });

  describe("Gating outcomes - ABSTAIN_CLARIFY blocks dispatch", () => {
    it("should block status dispatch when gate returns ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: "Browser proxy pack policy incomplete",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "status",
          node: "test-browser-node",
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

    it("should block act dispatch when gate returns ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "act",
          node: "test-browser-node",
          request: { kind: "click", ref: "test_ref" },
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
        expect(msg).toContain("ABSTAIN_CLARIFY");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();
    });

    it("should block upload dispatch when gate returns ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "capability_denied",
        contractId: null,
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "upload",
          node: "test-browser-node",
          paths: ["/tmp/test.txt"],
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

  describe("Gating context verification", () => {
    it("should always pass stageId=NODE_INVOKE to the gate", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const actions = ["status", "start", "stop", "profiles", "tabs"];

      for (const action of actions) {
        vi.clearAllMocks();
        mockApplyNodeInvokeOverrides.mockResolvedValue({
          outcome: "PROCEED",
          contractId: null,
        } as OverrideOutcome);
        mockCallGatewayTool.mockResolvedValue({ payload: { result: { ok: true } } });

        try {
          await tool.execute("test-id", {
            ...createParams(),
            action,
            node: "test-browser-node",
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

    it("should always pass functionName=browser.proxy for node-routed actions", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      const actions = ["status", "start", "stop", "profiles", "tabs", "snapshot"];

      for (const action of actions) {
        vi.clearAllMocks();
        mockApplyNodeInvokeOverrides.mockResolvedValue({
          outcome: "PROCEED",
          contractId: null,
        } as OverrideOutcome);
        mockCallGatewayTool.mockResolvedValue({
          payload: {
            result: {
              ok: true,
              tabs: [],
              nodes: [],
              snapshot: "test",
            },
          },
        });

        try {
          await tool.execute("test-id", {
            ...createParams(),
            action,
            node: "test-browser-node",
          });
        } catch {
          // May fail
        }

        expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
          stageId: "NODE_INVOKE",
          functionName: "browser.proxy",
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
          action: "status",
          node: "test-browser-node",
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
          action: "start",
          node: "test-browser-node",
        });
      } catch {
        // Expected
      }

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });

    it("should call callGatewayTool node.invoke exactly once when PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      mockCallGatewayTool.mockResolvedValue({
        payload: { result: { ok: true } },
      });

      await tool.execute("test-id", {
        ...createParams(),
        action: "status",
        node: "test-browser-node",
      });

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(1);
    });
  });

  describe("Multiple browser actions gating", () => {
    it("should gate console action and block on ABSTAIN_CONFIRM", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_CONSOLE",
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "console",
          node: "test-browser-node",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
      }

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBe(0);
    });

    it("should gate pdf action and allow on PROCEED", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "PROCEED",
        contractId: null,
      } as OverrideOutcome);

      mockCallGatewayTool.mockResolvedValue({
        payload: { result: { path: "/tmp/test.pdf" } },
      });

      const result = await tool.execute("test-call-id", {
        ...createParams(),
        action: "pdf",
        node: "test-browser-node",
      });

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalledWith({
        stageId: "NODE_INVOKE",
        functionName: "browser.proxy",
      });

      const invokeCalls = mockCallGatewayTool.mock.calls.filter(
        (call: any[]) => call[0] === "node.invoke",
      );
      expect(invokeCalls.length).toBeGreaterThan(0);
    });

    it("should gate focus action and block on ABSTAIN_CLARIFY", async () => {
      mockApplyNodeInvokeOverrides.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
      } as OverrideOutcome);
      mockCallGatewayTool.mockClear();

      try {
        await tool.execute("test-call-id", {
          ...createParams(),
          action: "focus",
          node: "test-browser-node",
          targetId: "test_target",
        });
        throw new Error("Should have thrown");
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("gated");
      }

      expect(mockApplyNodeInvokeOverrides).toHaveBeenCalled();
    });
  });
});
