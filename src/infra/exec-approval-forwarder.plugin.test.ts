import { afterEach, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import type { ApprovalRequestInput } from "./approval-types.js";
import * as fixtures from "./exec-approval-forwarder.test-support.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

const payload = { title: "Review", description: "Tool", policySubject: { pluginKey: "sage" } };
const request: PluginApprovalRequest = {
  id: "plugin:req-sage",
  request: payload,
  createdAtMs: 1000,
  expiresAtMs: 6000,
};
type Request = { request: ApprovalRequestInput };

function fixture(scoped: boolean) {
  vi.useFakeTimers();
  const suppress = vi.fn(({ request: approval }: Request) => !("title" in approval.request));
  const block = ({ request: approval }: Request) =>
    (approval.request as PluginApprovalRequest["request"]).policySubject?.pluginKey === "sage";
  const approvalCapability = {
    supportsScopedPluginApprovalApprovers: scoped,
    delivery: scoped
      ? { shouldBlockForwardingFallback: block }
      : { shouldSuppressForwardingFallback: suppress },
  };
  const channel = { ...createChannelTestPluginBase({ id: "slack" }), approvalCapability };
  const registration = { pluginId: "slack", plugin: channel, source: "test" };
  setActivePluginRegistry(createTestRegistry([registration]));
  const plugin = {
    ...fixtures.TARGETS_CFG.approvals!.exec,
    slack: scoped ? { plugins: { sage: { approvers: [] } } } : undefined,
  };
  const options = {
    cfg: { approvals: { plugin } },
    nativeRoutes: scoped
      ? []
      : [{ channel: "slack", accountId: "default", handledKinds: ["plugin" as const] }],
  };
  return { ...fixtures.createForwarder(options), suppress };
}

afterEach(async () => {
  await fixtures.stopForwarderFixtures();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setActivePluginRegistry(fixtures.emptyRegistry);
});

it.each(["pending", "uncached resolution", "scoped reviewer"] as const)(
  "forwards plugin approvals through %s policy",
  async (mode) => {
    const scoped = mode === "scoped reviewer";
    const { deliver, forwarder, suppress } = fixture(scoped);
    if (scoped) {
      await expect(forwarder.handlePluginApprovalRequested?.(request)).resolves.toBe(false);
      await fixtures.flushPendingDelivery();
      expect(deliver).not.toHaveBeenCalled();
    }
    if (mode === "uncached resolution") {
      await forwarder.handlePluginApprovalResolved?.({
        id: request.id,
        decision: "deny",
        ts: 2000,
        request: request.request,
      });
    } else {
      const approval = scoped
        ? {
            ...request,
            id: "plugin:req-other",
            request: { ...payload, policySubject: { pluginKey: "other" } },
          }
        : request;
      await expect(forwarder.handlePluginApprovalRequested?.(approval)).resolves.toBe(true);
    }
    await fixtures.flushPendingDelivery();
    if (!scoped) {
      const expected =
        mode === "pending"
          ? request
          : expect.objectContaining({ id: request.id, request: payload });
      expect(suppress).toHaveBeenCalledWith(
        expect.objectContaining({ approvalKind: "plugin", request: expected }),
      );
    }
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]?.[0]).not.toHaveProperty("skipQueue");
  },
);
