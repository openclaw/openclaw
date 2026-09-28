import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import { publishAppliedApprovalResolution } from "./approval-publication.js";

type PublishParams = Parameters<typeof publishAppliedApprovalResolution>[0];

async function publishSystemAgentTerminal(status: "allowed" | "denied" | "expired" | "cancelled") {
  const handleSystemAgentApprovalResolved = vi.fn(async () => {});
  await publishAppliedApprovalResolution({
    record: {
      id: "system-agent:1",
      kind: "system-agent",
      status,
      decision: status === "denied" ? "deny" : status === "allowed" ? "allow-once" : undefined,
      resolvedAtMs: 1,
    } as unknown as PublishParams["record"],
    liveRecord: { request: {}, resolvedBy: null } as unknown as PublishParams["liveRecord"],
    context: {
      broadcast: vi.fn(),
      broadcastToConnIds: vi.fn(),
    } as unknown as PublishParams["context"],
    forwarder: { handleSystemAgentApprovalResolved } as unknown as ExecApprovalForwarder,
  });
  return handleSystemAgentApprovalResolved;
}

describe("publishAppliedApprovalResolution for OpenClaw changes", () => {
  it("omits the requester message from plugin terminal broadcasts and delivery callbacks", async () => {
    const source = {
      channel: "slack",
      senderId: "U123",
      userMessageExcerpt: "private original message",
    };
    const request = {
      title: "Sensitive action",
      description: "Needs approval",
      approvalSource: source,
    };
    const broadcast = vi.fn();
    const publishResolved = vi.fn();
    const webExpired = vi.fn(async () => {});
    const forwardResolved = vi.fn(async () => {});
    const iosResolved = vi.fn(async () => {});
    await publishAppliedApprovalResolution({
      record: {
        id: "plugin:private",
        kind: "plugin",
        status: "expired",
        resolvedAtMs: 1,
      } as unknown as PublishParams["record"],
      liveRecord: { request, resolvedBy: null } as unknown as PublishParams["liveRecord"],
      context: {
        broadcast,
        approvalEvents: { publishResolved },
        approvalWebPushDelivery: { handleExpired: webExpired },
      } as unknown as PublishParams["context"],
      forwarder: {
        handlePluginApprovalResolved: forwardResolved,
      } as unknown as ExecApprovalForwarder,
      pluginIosPushDelivery: { handleResolved: iosResolved },
    });

    const publicSource = { channel: "slack", senderId: "U123" };
    expect(broadcast).toHaveBeenCalledWith(
      "plugin.approval.resolved",
      expect.objectContaining({
        request: expect.objectContaining({ approvalSource: publicSource }),
      }),
      { dropIfSlow: true },
    );
    expect(publishResolved).toHaveBeenCalledWith(
      "plugin",
      expect.objectContaining({ request: expect.objectContaining({ approvalSource: source }) }),
    );
    expect(webExpired).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ approvalSource: publicSource }),
      }),
    );
    for (const callback of [forwardResolved, iosResolved]) {
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({ approvalSource: publicSource }),
        }),
      );
    }
  });

  it.each(["expired", "cancelled"] as const)(
    "publishes the durable plugin %s status to native routes",
    async (status) => {
      const publishResolved = vi.fn();
      await publishAppliedApprovalResolution({
        record: {
          id: "plugin:1",
          kind: "plugin",
          status,
          resolvedAtMs: 1,
        } as unknown as PublishParams["record"],
        liveRecord: { request: {}, resolvedBy: null } as unknown as PublishParams["liveRecord"],
        context: {
          broadcast: vi.fn(),
          broadcastToConnIds: vi.fn(),
          approvalEvents: { publishResolved },
        } as unknown as PublishParams["context"],
      });
      expect(publishResolved).toHaveBeenCalledWith(
        "plugin",
        expect.objectContaining({ id: "plugin:1", terminalStatus: status }),
      );
    },
  );

  // Decisions publish their applied outcome from the system-agent owner; a
  // second chat update here would duplicate the terminal message.
  it.each(["allowed", "denied"] as const)(
    "leaves the %s chat outcome to the owner",
    async (status) => {
      expect(await publishSystemAgentTerminal(status)).not.toHaveBeenCalled();
    },
  );

  it.each(["expired", "cancelled"] as const)(
    "tells the chat when a change is %s",
    async (status) => {
      const forwarded = await publishSystemAgentTerminal(status);
      expect(forwarded).toHaveBeenCalledTimes(1);
      expect(forwarded).toHaveBeenCalledWith(expect.objectContaining({ terminalStatus: status }));
    },
  );
});
