import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalForwarder } from "../../infra/exec-approval-forwarder.js";
import { publishAppliedApprovalResolution } from "./approval-publication.js";

type PublishParams = Parameters<typeof publishAppliedApprovalResolution>[0];

async function publishSystemAgentTerminal(status: "denied" | "expired" | "cancelled") {
  const handleSystemAgentApprovalResolved = vi.fn(async () => {});
  await publishAppliedApprovalResolution({
    record: {
      id: "system-agent:1",
      kind: "system-agent",
      status,
      decision: status === "denied" ? "deny" : undefined,
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
  it("preserves requester context when a plugin approval expires", async () => {
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
      } as unknown as PublishParams["context"],
    });

    expect(broadcast).toHaveBeenCalledWith(
      "plugin.approval.resolved",
      expect.objectContaining({
        request: expect.objectContaining({ approvalSource: source }),
      }),
      { dropIfSlow: true },
    );
    expect(publishResolved).toHaveBeenCalledWith(
      "plugin",
      expect.objectContaining({ request: expect.objectContaining({ approvalSource: source }) }),
    );
  });

  // Decisions publish their applied outcome from the system-agent owner; a
  // second chat update here would duplicate the terminal message.
  it("leaves the denied chat outcome to the owner", async () => {
    expect(await publishSystemAgentTerminal("denied")).not.toHaveBeenCalled();
  });

  it.each(["expired", "cancelled"] as const)(
    "tells the chat when a change is %s",
    async (status) => {
      const forwarded = await publishSystemAgentTerminal(status);
      expect(forwarded).toHaveBeenCalledTimes(1);
      expect(forwarded).toHaveBeenCalledWith(expect.objectContaining({ terminalStatus: status }));
    },
  );
});
