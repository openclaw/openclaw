import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const emptyRegistry = createTestRegistry([]);

const TARGETS_CFG = {
  approvals: {
    exec: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "slack", to: "U123" }],
    },
  },
} as OpenClawConfig;

const DISABLED_CFG = {
  approvals: {
    exec: {
      enabled: false,
    },
  },
} as OpenClawConfig;

function createForwarder(params: { cfg: OpenClawConfig; deliver?: ReturnType<typeof vi.fn> }) {
  const deliver = params.deliver ?? vi.fn().mockResolvedValue([]);
  const forwarder = createExecApprovalForwarder({
    getConfig: () => params.cfg,
    deliver: deliver as unknown as NonNullable<
      NonNullable<Parameters<typeof createExecApprovalForwarder>[0]>["deliver"]
    >,
    nowMs: () => 1000,
  });
  return { deliver, forwarder };
}

function makePluginRequest(overrides?: Partial<PluginApprovalRequest>): PluginApprovalRequest {
  return {
    id: "plugin-req-1",
    request: {
      pluginId: "sage",
      title: "Sensitive tool call",
      description: "The agent wants to call a sensitive tool",
      severity: "warning",
      toolName: "bash",
      agentId: "main",
      sessionKey: "agent:main:main",
    },
    createdAtMs: 1000,
    expiresAtMs: 6000,
    ...overrides,
  };
}

describe("plugin approval forwarding", () => {
  beforeEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  describe("handlePluginApprovalRequested", () => {
    it("returns false when forwarding is disabled", async () => {
      const { forwarder } = createForwarder({ cfg: DISABLED_CFG });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(false);
    });

    it("forwards to configured targets", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(true);
      // Allow delivery to be async
      await vi.waitFor(() => {
        expect(deliver).toHaveBeenCalled();
      });
      const deliveryArgs = deliver.mock.calls[0]?.[0] as
        | { payloads?: Array<{ text?: string }> }
        | undefined;
      const text = deliveryArgs?.payloads?.[0]?.text ?? "";
      expect(text).toContain("Plugin approval required");
      expect(text).toContain("Sensitive tool call");
      expect(text).toContain("plugin-req-1");
      expect(text).toContain("/approve");
    });

    it("includes severity icon for critical", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });
      const request = makePluginRequest();
      request.request.severity = "critical";
      await forwarder.handlePluginApprovalRequested!(request);
      await vi.waitFor(() => {
        expect(deliver).toHaveBeenCalled();
      });
      const text =
        (deliver.mock.calls[0]?.[0] as { payloads?: Array<{ text?: string }> })?.payloads?.[0]
          ?.text ?? "";
      expect(text).toMatch(/🚨/);
    });
  });

  describe("handlePluginApprovalResolved", () => {
    it("delivers resolved message to targets", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });

      // First register request so targets are tracked
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      await vi.waitFor(() => {
        expect(deliver).toHaveBeenCalled();
      });
      deliver.mockClear();

      const resolved: PluginApprovalResolved = {
        id: "plugin-req-1",
        decision: "allow-once",
        resolvedBy: "telegram:user123",
        ts: 2000,
      };
      await forwarder.handlePluginApprovalResolved!(resolved);
      expect(deliver).toHaveBeenCalled();
      const text =
        (deliver.mock.calls[0]?.[0] as { payloads?: Array<{ text?: string }> })?.payloads?.[0]
          ?.text ?? "";
      expect(text).toContain("Plugin approval");
      expect(text).toContain("allowed once");
    });
  });

  describe("stop", () => {
    it("clears pending plugin approvals", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: TARGETS_CFG, deliver });
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      forwarder.stop();
      // After stop, resolved should not deliver
      deliver.mockClear();
      await forwarder.handlePluginApprovalResolved!({
        id: "plugin-req-1",
        decision: "deny",
        ts: 2000,
      });
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});
