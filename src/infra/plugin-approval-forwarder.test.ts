import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createExecApprovalForwarder } from "./exec-approval-forwarder.js";
import type { PluginApprovalRequest, PluginApprovalResolved } from "./plugin-approvals.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const emptyRegistry = createTestRegistry([]);

const PLUGIN_TARGETS_CFG = {
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "slack", to: "U123" }],
    },
  },
} as OpenClawConfig;

const PLUGIN_DISABLED_CFG = {
  approvals: {
    plugin: {
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
      const { forwarder } = createForwarder({ cfg: PLUGIN_DISABLED_CFG });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(false);
    });

    it("forwards to configured targets", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
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
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
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

    it("returns false when exec enabled but plugin disabled", async () => {
      const cfg = {
        approvals: {
          exec: { enabled: true, mode: "targets", targets: [{ channel: "slack", to: "U123" }] },
          plugin: { enabled: false },
        },
      } as OpenClawConfig;
      const { forwarder } = createForwarder({ cfg });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(false);
    });

    it("forwards when plugin enabled but exec disabled", async () => {
      const cfg = {
        approvals: {
          exec: { enabled: false },
          plugin: {
            enabled: true,
            mode: "targets",
            targets: [{ channel: "slack", to: "U123" }],
          },
        },
      } as OpenClawConfig;
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg, deliver });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(true);
      await vi.waitFor(() => {
        expect(deliver).toHaveBeenCalled();
      });
    });

    it("returns false when no approvals config at all", async () => {
      const cfg = {} as OpenClawConfig;
      const { forwarder } = createForwarder({ cfg });
      const result = await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      expect(result).toBe(false);
    });
  });

  describe("channel adapter hooks", () => {
    it("uses buildPluginPendingPayload from channel adapter when available", async () => {
      const mockPayload = { text: "custom adapter payload" };
      const adapterPlugin: Pick<
        ChannelPlugin,
        "id" | "meta" | "capabilities" | "config" | "execApprovals"
      > = {
        ...createChannelTestPluginBase({ id: "slack" as ChannelPlugin["id"] }),
        execApprovals: {
          buildPluginPendingPayload: vi.fn().mockReturnValue(mockPayload),
        },
      };
      const registry = createTestRegistry([
        { pluginId: "slack", plugin: adapterPlugin, source: "test" },
      ]);
      setActivePluginRegistry(registry);

      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      await vi.waitFor(() => {
        expect(deliver).toHaveBeenCalled();
      });
      const deliveryArgs = deliver.mock.calls[0]?.[0] as
        | { payloads?: Array<{ text?: string }> }
        | undefined;
      expect(deliveryArgs?.payloads?.[0]?.text).toBe("custom adapter payload");
    });

    it("falls back to plugin text when no adapter exists", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      await vi.waitFor(() => {
        expect(deliver).toHaveBeenCalled();
      });
      const text =
        (deliver.mock.calls[0]?.[0] as { payloads?: Array<{ text?: string }> })?.payloads?.[0]
          ?.text ?? "";
      expect(text).toContain("Plugin approval required");
    });

    it("calls beforeDeliverPending before plugin approval delivery", async () => {
      const beforeDeliverPending = vi.fn();
      const adapterPlugin: Pick<
        ChannelPlugin,
        "id" | "meta" | "capabilities" | "config" | "execApprovals"
      > = {
        ...createChannelTestPluginBase({ id: "slack" as ChannelPlugin["id"] }),
        execApprovals: {
          beforeDeliverPending,
        },
      };
      const registry = createTestRegistry([
        { pluginId: "slack", plugin: adapterPlugin, source: "test" },
      ]);
      setActivePluginRegistry(registry);

      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      await vi.waitFor(() => {
        expect(deliver).toHaveBeenCalled();
      });
      expect(beforeDeliverPending).toHaveBeenCalled();
    });

    it("uses buildPluginResolvedPayload from channel adapter for resolved messages", async () => {
      const mockPayload = { text: "custom resolved payload" };
      const adapterPlugin: Pick<
        ChannelPlugin,
        "id" | "meta" | "capabilities" | "config" | "execApprovals"
      > = {
        ...createChannelTestPluginBase({ id: "slack" as ChannelPlugin["id"] }),
        execApprovals: {
          buildPluginResolvedPayload: vi.fn().mockReturnValue(mockPayload),
        },
      };
      const registry = createTestRegistry([
        { pluginId: "slack", plugin: adapterPlugin, source: "test" },
      ]);
      setActivePluginRegistry(registry);

      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });

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
      const deliveryArgs = deliver.mock.calls[0]?.[0] as
        | { payloads?: Array<{ text?: string }> }
        | undefined;
      expect(deliveryArgs?.payloads?.[0]?.text).toBe("custom resolved payload");
    });
  });

  describe("handlePluginApprovalResolved", () => {
    it("delivers resolved message to targets", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });

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

    it("reconstructs targets from resolved request snapshot when pending cache is missing", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });

      await forwarder.handlePluginApprovalResolved!({
        id: "plugin-req-late",
        decision: "deny",
        resolvedBy: "telegram:user123",
        ts: 2_000,
        request: {
          pluginId: "sage",
          title: "Sensitive tool call",
          description: "The agent wants to call a sensitive tool",
          severity: "warning",
          toolName: "bash",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      });

      expect(deliver).toHaveBeenCalled();
      const text =
        (deliver.mock.calls[0]?.[0] as { payloads?: Array<{ text?: string }> })?.payloads?.[0]
          ?.text ?? "";
      expect(text).toContain("Plugin approval");
      expect(text).toContain("denied");
    });
  });

  describe("stop", () => {
    it("clears pending plugin approvals", async () => {
      const deliver = vi.fn().mockResolvedValue([]);
      const { forwarder } = createForwarder({ cfg: PLUGIN_TARGETS_CFG, deliver });
      await forwarder.handlePluginApprovalRequested!(makePluginRequest());
      // Wait for the async delivery to flush before stopping
      await vi.waitFor(() => {
        expect(deliver).toHaveBeenCalled();
      });
      forwarder.stop();
      deliver.mockClear();
      // After stop, resolved should not deliver
      await forwarder.handlePluginApprovalResolved!({
        id: "plugin-req-1",
        decision: "deny",
        ts: 2000,
      });
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});
