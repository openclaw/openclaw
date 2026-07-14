import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { advanceCloudDraftSession } from "./cloud-submit.ts";

function clientWith(request: ReturnType<typeof vi.fn>): Pick<GatewayBrowserClient, "request"> {
  return { request: request as GatewayBrowserClient["request"] };
}

describe("cloud draft advancement", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("tears down a recovered worker when recovery storage becomes unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("storage disabled", "SecurityError");
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        session: { placement: { state: "active", environmentId: "environment-recovered" } },
      })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, deleted: true });
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        profileId: "aws",
        message: "resume remotely",
        messageId: "message-recovered",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recovering: true,
        isCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
      }),
    ).resolves.toEqual({ status: "cancelled", recoveryPersisted: false });
    expect(request.mock.calls).toEqual([
      ["sessions.describe", { key: "agent:cloud:recovered" }],
      ["environments.destroy", { environmentId: "environment-recovered" }],
      [
        "sessions.delete",
        { key: "agent:cloud:recovered", agentId: "cloud", deleteTranscript: true },
      ],
    ]);
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it("does not overwrite recovery after submission ownership is lost", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
      JSON.stringify({
        sessionKey: "agent:cloud:newer",
        messageId: "message-newer",
        message: "newer task",
        profileId: "aws",
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
      }),
    );
    const request = vi.fn().mockResolvedValueOnce({ ok: true, deleted: true });

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:stale",
        agentId: "cloud",
        profileId: "aws",
        message: "stale task",
        messageId: "message-stale",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recovering: false,
        isCurrent: () => false,
        ownsRecovery: () => false,
        clearRecovery: vi.fn(),
      }),
    ).resolves.toEqual({ status: "cancelled", recoveryPersisted: false });
    expect(
      JSON.parse(
        sessionStorage.getItem(
          "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
        ) ?? "null",
      ),
    ).toMatchObject({ sessionKey: "agent:cloud:newer" });
  });

  it("preserves a recovered transcript after terminal placement", async () => {
    const request = vi.fn().mockResolvedValueOnce({
      session: { placement: { state: "failed" } },
    });
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:recovered",
        agentId: "cloud",
        profileId: "aws",
        message: "possibly accepted task",
        messageId: "message-recovered",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recovering: true,
        isCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
      }),
    ).resolves.toEqual({
      status: "send-rejected",
      error: "cloud worker placement became failed",
      messageId: "message-recovered",
    });
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).not.toHaveBeenCalled();
  });
});
