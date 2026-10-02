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
