// Plugin approval fallback routing and durable queue eligibility.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ApprovalRequestInput } from "./approval-types.js";
import {
  createForwarder,
  emptyRegistry,
  flushPendingDelivery,
  stopForwarderFixtures,
} from "./exec-approval-forwarder.test-support.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

const cfg: OpenClawConfig = {
  approvals: {
    plugin: { enabled: true, mode: "targets", targets: [{ channel: "slack", to: "U123" }] },
  },
};
const request: PluginApprovalRequest = {
  id: "plugin:req-sage",
  request: {
    pluginId: "sage",
    title: "Review action",
    description: "Review the selected tool",
    policySubject: { pluginKey: "sage", tool: "run" },
  },
  createdAtMs: 1000,
  expiresAtMs: 6000,
};

function registerSlackApprovalCapability(approvalCapability: ChannelPlugin["approvalCapability"]) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "slack",
        plugin: { ...createChannelTestPluginBase({ id: "slack" }), approvalCapability },
        source: "test",
      },
    ]),
  );
}

describe("plugin approval forwarding", () => {
  beforeEach(() => setActivePluginRegistry(emptyRegistry));
  afterEach(async () => {
    await stopForwarderFixtures();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setActivePluginRegistry(emptyRegistry);
  });

  it("passes the plugin request to fallback suppression for pending and uncached resolved approvals", async () => {
    vi.useFakeTimers();
    const shouldSuppressForwardingFallback = vi.fn(
      ({ request: approval }: { request: ApprovalRequestInput }) => !("title" in approval.request),
    );
    registerSlackApprovalCapability({ delivery: { shouldSuppressForwardingFallback } });
    const options = {
      cfg,
      nativeRoutes: [{ channel: "slack", accountId: "default", handledKinds: ["plugin" as const] }],
    };
    const { deliver, forwarder } = createForwarder(options);

    await expect(forwarder.handlePluginApprovalRequested?.(request)).resolves.toBe(true);
    await flushPendingDelivery();
    expect(shouldSuppressForwardingFallback).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "plugin", request }),
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty("skipQueue");

    const replay = createForwarder(options);
    await replay.forwarder.handlePluginApprovalResolved?.({
      id: request.id,
      decision: "deny",
      ts: 2000,
      request: request.request,
    });
    expect(shouldSuppressForwardingFallback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        approvalKind: "plugin",
        request: expect.objectContaining({ id: request.id, request: request.request }),
      }),
    );
    expect(replay.deliver).toHaveBeenCalledTimes(1);
    expect(replay.deliver.mock.calls[0]?.[0]).not.toHaveProperty("skipQueue");
  });

  it("blocks a selected reviewer policy even without a running native handler", async () => {
    const shouldBlockForwardingFallback = vi.fn(
      ({ request: approval }: { request: ApprovalRequestInput }) =>
        (approval.request as PluginApprovalRequest["request"]).policySubject?.pluginKey === "sage",
    );
    registerSlackApprovalCapability({
      supportsScopedPluginApprovalApprovers: true,
      delivery: { shouldBlockForwardingFallback },
    });
    const { deliver, forwarder } = createForwarder({
      cfg: {
        approvals: {
          plugin: { ...cfg.approvals!.plugin, slack: { plugins: { sage: { approvers: [] } } } },
        },
      },
    });

    await expect(forwarder.handlePluginApprovalRequested?.(request)).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    await expect(
      forwarder.handlePluginApprovalRequested?.({
        ...request,
        id: "plugin:req-other",
        request: { ...request.request, policySubject: { pluginKey: "other" } },
      }),
    ).resolves.toBe(true);
    await flushPendingDelivery();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty("skipQueue");
  });
});
