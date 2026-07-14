import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { advanceCloudDraftSession } from "./cloud-submit.ts";

function clientWith(request: ReturnType<typeof vi.fn>): Pick<GatewayBrowserClient, "request"> {
  return { request: request as GatewayBrowserClient["request"] };
}

describe("cloud draft advancement", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("preserves a recovered session when recovery storage becomes unavailable", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
      JSON.stringify({
        sessionKey: "agent:cloud:recovered",
        messageId: "message-recovered",
        message: "resume remotely",
        profileId: "aws",
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "sending",
      }),
    );
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(() => {
        throw new DOMException("storage disabled", "SecurityError");
      }),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    });
    const request = vi.fn();
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
        recoveryPhase: "sending",
        recovering: true,
        isCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "cancelled",
      cleanupError: "cloud recovery storage is unavailable",
      recoveryPersisted: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(clearRecovery).not.toHaveBeenCalled();
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
        phase: "dispatching",
      }),
    );
    const request = vi.fn().mockResolvedValueOnce({ ok: true, deleted: true });
    const clearRecovery = vi.fn();

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
        recoveryPhase: "dispatching",
        recovering: false,
        isCurrent: () => false,
        ownsRecovery: () => false,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({ status: "cancelled", recoveryPersisted: false });
    expect(
      JSON.parse(
        sessionStorage.getItem(
          "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
        ) ?? "null",
      ),
    ).toMatchObject({ sessionKey: "agent:cloud:newer" });
    expect(clearRecovery).toHaveBeenCalledOnce();
  });

  it("keeps a cancelled draft recoverable when its cleanup fails", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("delete unavailable"));
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:cancelled",
        agentId: "cloud",
        profileId: "aws",
        message: "cancelled task",
        messageId: "message-cancelled",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        recovering: false,
        isCurrent: () => false,
        ownsRecovery: () => false,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "cancelled",
      cleanupError: "delete unavailable",
      recoveryPersisted: true,
    });
    expect(
      JSON.parse(
        sessionStorage.getItem(
          "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
        ) ?? "null",
      ),
    ).toMatchObject({ sessionKey: "agent:cloud:cancelled" });
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("redispatches a recovered transcript after terminal placement", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
      JSON.stringify({
        sessionKey: "agent:cloud:recovered",
        messageId: "message-recovered",
        message: "possibly accepted task",
        profileId: "aws",
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "sending",
      }),
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } })
      .mockResolvedValueOnce({ placement: { state: "active", environmentId: "environment-2" } })
      .mockRejectedValueOnce(new Error("send response lost"));
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
        recoveryPhase: "sending",
        recovering: true,
        isCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "send-rejected",
      error: "send response lost",
      messageId: "message-recovered",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.dispatch", {
      key: "agent:cloud:recovered",
      agentId: "cloud",
      profileId: "aws",
    });
    expect(request).toHaveBeenNthCalledWith(
      3,
      "sessions.send",
      expect.objectContaining({ idempotencyKey: "message-recovered" }),
    );
    expect(request).not.toHaveBeenCalledWith("sessions.delete", expect.anything());
    expect(clearRecovery).not.toHaveBeenCalled();
  });

  it("deletes a terminal recovery that never reached first-turn sending", async () => {
    sessionStorage.setItem(
      "openclaw.new-session.cloud-recovery.v1:ws://gateway.example:principal-a",
      JSON.stringify({
        sessionKey: "agent:cloud:pre-send",
        messageId: "message-pre-send",
        message: "not sent yet",
        profileId: "aws",
        agentId: "cloud",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        phase: "dispatching",
      }),
    );
    const request = vi
      .fn()
      .mockResolvedValueOnce({ session: { placement: { state: "failed" } } })
      .mockResolvedValueOnce({ ok: true, deleted: true });
    const clearRecovery = vi.fn();

    await expect(
      advanceCloudDraftSession({
        client: clientWith(request),
        key: "agent:cloud:pre-send",
        agentId: "cloud",
        profileId: "aws",
        message: "not sent yet",
        messageId: "message-pre-send",
        gatewayUrl: "ws://gateway.example",
        recoveryScope: "principal-a",
        recoveryPhase: "dispatching",
        recovering: true,
        isCurrent: () => true,
        ownsRecovery: () => true,
        clearRecovery,
        setRecoveryPhase: vi.fn(),
      }),
    ).resolves.toEqual({
      status: "dispatch-rejected",
      error: "cloud worker placement became failed",
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.delete", {
      key: "agent:cloud:pre-send",
      agentId: "cloud",
      deleteTranscript: true,
    });
    expect(clearRecovery).toHaveBeenCalledOnce();
  });
});
