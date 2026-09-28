// Plugin approval fallback, queue eligibility, and live Slack policy fences.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ApprovalRequestInput } from "./approval-types.js";
import {
  baseRequest,
  createForwarder,
  defaultRegistry,
  emptyRegistry,
  flushPendingDelivery,
  type NativeRouteFixture,
  requireFirstCallArg,
  stopForwarderFixtures,
} from "./exec-approval-forwarder.test-support.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

describe("plugin approval forwarding", () => {
  beforeEach(() => setActivePluginRegistry(defaultRegistry));
  afterEach(async () => {
    await stopForwarderFixtures();
    vi.useRealTimers();
    vi.restoreAllMocks();
    setActivePluginRegistry(emptyRegistry);
  });

  const telegramCfg = {
    approvals: { exec: { enabled: true, mode: "session" } },
    channels: {
      telegram: { execApprovals: { enabled: true, approvers: ["123"], target: "channel" } },
    },
  } as OpenClawConfig;
  const telegramRequest = {
    ...baseRequest,
    request: {
      ...baseRequest.request,
      turnSourceChannel: "telegram",
      turnSourceTo: "-100999",
      turnSourceThreadId: "77",
      turnSourceAccountId: "default",
    },
  };
  const resolveSessionTarget = () => ({ channel: "telegram", to: "-100999", threadId: 77 });

  it.each<{ nativeRoutes: NativeRouteFixture[]; forwarded: boolean }>([
    { nativeRoutes: [], forwarded: true },
    { nativeRoutes: [{ channel: "telegram", accountId: "default" }], forwarded: false },
    {
      nativeRoutes: [{ channel: "telegram", accountId: "default", handledKinds: ["exec"] }],
      forwarded: true,
    },
  ])(
    "gates plugin approvals on the running native handler %j",
    async ({ nativeRoutes, forwarded }) => {
      vi.useFakeTimers();
      const { deliver, forwarder } = createForwarder({
        cfg: { ...telegramCfg, approvals: { plugin: { enabled: true, mode: "session" } } },
        resolveSessionTarget,
        nativeRoutes,
      });

      await expect(
        forwarder.handlePluginApprovalRequested?.({
          ...telegramRequest,
          id: "plugin:req-1",
          request: {
            title: "Demo",
            description: "Demo approval",
            turnSourceChannel: "telegram",
            turnSourceTo: "-100999",
            turnSourceAccountId: "default",
          },
        }),
      ).resolves.toBe(forwarded);
      expect(deliver).toHaveBeenCalledTimes(forwarded ? 1 : 0);
      if (forwarded) {
        expect(
          requireFirstCallArg(deliver, "telegram plugin approval delivery"),
        ).not.toHaveProperty("skipQueue");
      }
    },
  );

  it("passes the plugin request to native fallback suppression", async () => {
    vi.useFakeTimers();
    const shouldSuppressForwardingFallback = vi.fn(
      ({ request }: { request: ApprovalRequestInput }) => !("title" in request.request),
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            approvalCapability: { delivery: { shouldSuppressForwardingFallback } },
          },
          source: "test",
        },
      ]),
    );
    const cfg = {
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123" }],
        },
      },
    } as OpenClawConfig;
    const request: PluginApprovalRequest = {
      id: "plugin:req-1",
      request: {
        pluginId: "sage",
        title: "Review action",
        description: "Review the selected tool",
        policySubject: { pluginKey: "sage", tool: "run" },
      },
      createdAtMs: 1000,
      expiresAtMs: 6000,
    };
    const { deliver, forwarder } = createForwarder({
      cfg,
      nativeRoutes: [{ channel: "slack", accountId: "default", handledKinds: ["plugin"] }],
    });

    await expect(forwarder.handlePluginApprovalRequested?.(request)).resolves.toBe(true);
    await flushPendingDelivery();
    expect(shouldSuppressForwardingFallback).toHaveBeenCalledWith(
      expect.objectContaining({ approvalKind: "plugin", request }),
    );
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(requireFirstCallArg(deliver, "unscoped plugin pending delivery")).not.toHaveProperty(
      "skipQueue",
    );

    await vi.advanceTimersByTimeAsync(request.expiresAtMs - request.createdAtMs);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1]?.[0]).not.toHaveProperty("skipQueue");

    const replay = createForwarder({
      cfg,
      nativeRoutes: [{ channel: "slack", accountId: "default", handledKinds: ["plugin"] }],
    });
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
    expect(
      requireFirstCallArg(replay.deliver, "unscoped plugin resolved delivery"),
    ).not.toHaveProperty("skipQueue");
  });

  it("blocks a selected reviewer policy even without a running native handler", async () => {
    const shouldBlockForwardingFallback = vi.fn(
      ({ request }: { request: ApprovalRequestInput }) =>
        (request.request as PluginApprovalRequest["request"]).policySubject?.pluginKey === "sage",
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            approvalCapability: {
              supportsScopedPluginApprovalApprovers: true,
              delivery: { shouldBlockForwardingFallback },
            },
          },
          source: "test",
        },
      ]),
    );
    const cfg = {
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123" }],
          slack: { plugins: { sage: { approvers: [] } } },
        },
      },
    } as OpenClawConfig;
    const { deliver, forwarder } = createForwarder({ cfg });
    const request: PluginApprovalRequest = {
      id: "plugin:req-sage",
      request: {
        title: "Review action",
        description: "Review the selected tool",
        policySubject: { pluginKey: "sage" },
      },
      createdAtMs: 1000,
      expiresAtMs: 6000,
    };

    await expect(forwarder.handlePluginApprovalRequested?.(request)).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    await expect(
      forwarder.handlePluginApprovalRequested?.({
        ...request,
        id: "plugin:req-other",
        request: {
          ...request.request,
          policySubject: { pluginKey: "other" },
        },
      }),
    ).resolves.toBe(true);
    await flushPendingDelivery();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(requireFirstCallArg(deliver, "unmatched plugin fallback delivery")).not.toHaveProperty(
      "skipQueue",
    );
  });

  it("drops queued generic plugin cards and terminal notices after reviewer policy changes", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const beforeDeliverPayload = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const shouldBlockForwardingFallback = vi.fn(
      ({ cfg }: { cfg: OpenClawConfig }) => cfg.approvals?.plugin?.slack !== undefined,
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            outbound: { deliveryMode: "direct", beforeDeliverPayload },
            approvalCapability: {
              supportsScopedPluginApprovalApprovers: true,
              delivery: { shouldBlockForwardingFallback },
            },
          },
          source: "test",
        },
      ]),
    );
    const cfg = {
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123" }],
        },
      },
    } as OpenClawConfig;
    const { deliver, forwarder } = createForwarder({ cfg });
    const request: PluginApprovalRequest = {
      id: "plugin:policy-change",
      request: { title: "Review action", description: "Review the selected tool" },
      createdAtMs: 1000,
      expiresAtMs: 6000,
    };

    await expect(forwarder.handlePluginApprovalRequested?.(request)).resolves.toBe(true);
    await entered.promise;
    cfg.approvals!.plugin!.slack = { approvers: ["team:T11111111:user:U11111111"] };
    release.resolve();
    await forwarder.handlePluginApprovalResolved?.({
      id: request.id,
      decision: "deny",
      ts: 2000,
      request: request.request,
    });
    await forwarder.stop();
    expect(beforeDeliverPayload).toHaveBeenCalledTimes(1);
    expect(shouldBlockForwardingFallback).toHaveBeenCalledTimes(3);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fences a generic plugin card at platform dispatch after outbound delivery starts", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const posts: string[] = [];
    let rejection: unknown;
    const shouldBlockForwardingFallback = vi.fn(
      ({ cfg }: { cfg: OpenClawConfig }) => cfg.approvals?.plugin?.slack !== undefined,
    );
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            approvalCapability: {
              supportsScopedPluginApprovalApprovers: true,
              delivery: { shouldBlockForwardingFallback },
            },
          },
          source: "test",
        },
      ]),
    );
    const cfg = {
      approvals: {
        plugin: {
          enabled: true,
          mode: "targets",
          targets: [{ channel: "slack", to: "U123" }],
        },
      },
    } as OpenClawConfig;
    const deliver = vi.fn(
      async (delivery: {
        payloads: Array<{ text?: string }>;
        skipQueue?: boolean;
        onPlatformSendDispatch?: () => Promise<void>;
        assertDirectAdapterHandoff?: () => void;
      }) => {
        await delivery.onPlatformSendDispatch?.();
        entered.resolve();
        await release.promise;
        try {
          delivery.assertDirectAdapterHandoff?.();
          posts.push(delivery.payloads[0]?.text ?? "");
        } catch (error) {
          rejection = error;
        }
        return [];
      },
    );
    const { forwarder } = createForwarder({ cfg, deliver });
    const request: PluginApprovalRequest = {
      id: "plugin:queued-dispatch",
      request: { title: "Review action", description: "Review the selected tool" },
      createdAtMs: 1000,
      expiresAtMs: 6000,
    };

    await expect(forwarder.handlePluginApprovalRequested?.(request)).resolves.toBe(true);
    await entered.promise;
    cfg.approvals!.plugin!.slack = { approvers: ["team:T11111111:user:U11111111"] };
    release.resolve();
    await forwarder.stop();

    expect(deliver).toHaveBeenCalledOnce();
    expect(requireFirstCallArg(deliver, "delivery params")).toMatchObject({
      onPlatformSendDispatch: expect.any(Function),
      assertDirectAdapterHandoff: expect.any(Function),
    });
    expect(requireFirstCallArg(deliver, "delivery params")).not.toHaveProperty("skipQueue");
    expect(rejection).toMatchObject({
      message: "plugin approval forwarding is no longer authorized",
    });
    expect(posts).toEqual([]);
  });
});
