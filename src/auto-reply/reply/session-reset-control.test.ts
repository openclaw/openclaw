// Tests lifecycle-fenced authorization of active-run reset control.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthorizationPrincipal } from "../../plugins/authorization-policy-context.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { prepareReplySessionResetActiveRunControl } from "./session-reset-control.js";

const runtimeMocks = vi.hoisted(() => ({
  abortActiveRunWithSteeringAuthorization: vi.fn(),
  authorizedActiveRunAbortObservedReplacement: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  waitForEmbeddedAgentRunEnd: vi.fn(),
}));

vi.mock("../../agents/embedded-agent.runtime.js", () => runtimeMocks);

const target = {
  scope: "/tmp/session-reset-control-test",
  sessionId: "active-session",
  sessionKey: "agent:main:discord:channel:1",
} as const;

function createSenderAuthority(senderId: string) {
  return createTurnAuthoritySnapshot({
    principal: createAuthorizationPrincipal({
      provider: "discord",
      senderId,
      isAuthorizedSender: true,
    }),
    agentId: "main",
    sessionKey: target.sessionKey,
    conversationId: "discord:channel:1",
    controllerKey: `sender:discord:${senderId}`,
  });
}

describe("prepareReplySessionResetActiveRunControl", () => {
  beforeEach(() => {
    runtimeMocks.abortActiveRunWithSteeringAuthorization.mockReset();
    runtimeMocks.authorizedActiveRunAbortObservedReplacement.mockReset();
    runtimeMocks.resolveActiveEmbeddedRunSessionId.mockReset();
    runtimeMocks.waitForEmbeddedAgentRunEnd.mockReset();
  });

  it("denies another controller before waiting or clearing the run", async () => {
    runtimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("active-session");
    runtimeMocks.abortActiveRunWithSteeringAuthorization.mockReturnValue({
      status: "unauthorized",
      replacementObserved: false,
    });

    await expect(
      prepareReplySessionResetActiveRunControl({
        target,
      }),
    ).rejects.toMatchObject({
      name: "ReplySessionResetControlError",
      reason: "unauthorized",
    });
    expect(runtimeMocks.abortActiveRunWithSteeringAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "active-session", policy: "exact" }),
    );
    expect(runtimeMocks.waitForEmbeddedAgentRunEnd).not.toHaveBeenCalled();
  });

  it("rechecks the captured run after lifecycle admissions drain", async () => {
    runtimeMocks.resolveActiveEmbeddedRunSessionId
      .mockReturnValueOnce("active-session")
      .mockReturnValueOnce(undefined);
    const outcome = { status: "aborted", replacementObserved: false } as const;
    runtimeMocks.abortActiveRunWithSteeringAuthorization.mockReturnValue(outcome);
    runtimeMocks.authorizedActiveRunAbortObservedReplacement.mockReturnValue(false);
    runtimeMocks.waitForEmbeddedAgentRunEnd.mockResolvedValue(true);

    const prepared = await prepareReplySessionResetActiveRunControl({
      target,
    });
    expect(prepared).toBeDefined();
    await prepared?.afterInterrupt();

    expect(runtimeMocks.waitForEmbeddedAgentRunEnd).toHaveBeenCalledWith(
      "active-session",
      expect.any(Number),
    );
    expect(runtimeMocks.authorizedActiveRunAbortObservedReplacement).toHaveBeenCalledTimes(2);
  });

  it("fails busy when an active run does not match the fenced session identity", async () => {
    runtimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue("replacement-session");

    await expect(
      prepareReplySessionResetActiveRunControl({
        target,
      }),
    ).rejects.toMatchObject({
      name: "ReplySessionResetControlError",
      reason: "busy",
    });
    expect(runtimeMocks.abortActiveRunWithSteeringAuthorization).not.toHaveBeenCalled();
  });

  it("fails busy before runtime control when an active admission is unattributed", async () => {
    const onInterrupt = vi.fn();
    const admission = await beginSessionWorkAdmission({
      scope: target.scope,
      identities: [target.sessionKey, target.sessionId],
      assertAllowed: () => {},
      onInterrupt,
    });

    try {
      await expect(
        prepareReplySessionResetActiveRunControl({
          target,
          turnAuthority: createSenderAuthority("maintainer"),
        }),
      ).rejects.toMatchObject({ reason: "busy" });
      expect(runtimeMocks.resolveActiveEmbeddedRunSessionId).not.toHaveBeenCalled();
      expect(runtimeMocks.abortActiveRunWithSteeringAuthorization).not.toHaveBeenCalled();
      expect(onInterrupt).not.toHaveBeenCalled();
    } finally {
      admission.release();
    }
  });

  it("denies an attributed foreign admission before runtime control", async () => {
    const admission = await beginSessionWorkAdmission({
      scope: target.scope,
      identities: [target.sessionKey, target.sessionId],
      assertAllowed: () => {},
      turnAuthority: createSenderAuthority("other-maintainer"),
    });

    try {
      await expect(
        prepareReplySessionResetActiveRunControl({
          target,
          turnAuthority: createSenderAuthority("maintainer"),
        }),
      ).rejects.toMatchObject({ reason: "unauthorized" });
      expect(runtimeMocks.resolveActiveEmbeddedRunSessionId).not.toHaveBeenCalled();
    } finally {
      admission.release();
    }
  });

  it("accepts an exact-authority admission when no runtime handle exists", async () => {
    const turnAuthority = createSenderAuthority("maintainer");
    const admission = await beginSessionWorkAdmission({
      scope: target.scope,
      identities: [target.sessionKey, target.sessionId],
      assertAllowed: () => {},
      turnAuthority,
    });
    runtimeMocks.resolveActiveEmbeddedRunSessionId.mockReturnValue(undefined);

    try {
      await expect(
        prepareReplySessionResetActiveRunControl({ target, turnAuthority }),
      ).resolves.toBeUndefined();
      expect(runtimeMocks.resolveActiveEmbeddedRunSessionId).toHaveBeenCalledWith(
        target.sessionKey,
      );
    } finally {
      admission.release();
    }
  });
});
