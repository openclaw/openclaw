import { expect, it, vi } from "vitest";
import { createTestOperatorAuthority } from "../agents/admitted-run-context.test-support.js";
import {
  retainSessionParticipation,
  publishSessionParticipationMemberChange,
} from "../config/sessions/session-participation-source.js";
import { prepareGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { canRequesterAbortChatRun } from "./server-methods/chat-abort-authorization.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

it("keeps inherited invocation custody through retention and authorized incarnation rollover", async () => {
  const target = {
    profileId: "participant",
    agentId: "main",
    sessionKey: "agent:main:scope",
    sessionId: "before",
  };
  const lifetime = retainSessionParticipation(target);
  const released = vi.fn(lifetime.release);
  const inherited = createTestOperatorAuthority({
    canonicalIdentity: null,
    profileId: target.profileId,
    scopes: ["operator.sessions.read"],
  });
  const captured = await prepareGatewayOperatorRunAuthority({
    client: {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        role: "operator",
        scopes: inherited.scopes.slice(),
        client: { id: "gateway-client", version: "test", platform: "node", mode: "backend" },
      },
      internal: { operatorRunAuthority: inherited },
    },
    context: { getRuntimeConfig: () => ({}) } as GatewayRequestContext,
    invocationAuthority: {
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
      release: released,
    },
  });
  const releaseRetained = captured?.authority.retain?.();
  captured?.release();
  expect(released).not.toHaveBeenCalled();
  lifetime.followIncarnation("unrelated", "wrong");
  lifetime.followIncarnation("before", "after");
  publishSessionParticipationMemberChange(target.agentId, target.sessionKey, {
    sessionId: target.sessionId,
    identityId: target.profileId,
    present: false,
  });
  expect(captured?.authority.signal?.aborted).toBe(false);
  publishSessionParticipationMemberChange(target.agentId, target.sessionKey, {
    sessionId: "after",
    identityId: target.profileId,
    present: false,
  });
  expect(captured?.authority.signal?.aborted).toBe(true);
  expect(() => captured?.authority.signal?.throwIfAborted()).toThrow();
  lifetime.followIncarnation("after", "reinvited");
  expect(lifetime.signal.aborted).toBe(true);
  releaseRetained?.();
  expect(released).toHaveBeenCalledTimes(1);
});

it("participant Stop follows the original profile and exact target, never a matching transport", () => {
  const target = { agentId: "main", sessionKey: "agent:main:scope", sessionId: "current" };
  const initiator = createTestOperatorAuthority({
    canonicalIdentity: null,
    profileId: "participant",
    scopes: [],
  });
  const requester = {
    participationOnly: true,
    isAdmin: false,
    connId: "same-device",
    deviceId: "same-device",
    personalAuthority: { profileId: "participant", target, assertCurrent() {} },
  };
  const entry = {
    ...target,
    initiatingPersonalOperator: initiator,
    requester: { connectionId: "different-tab" },
  };
  expect(canRequesterAbortChatRun(entry, requester)).toBe(true);
  for (const changed of [
    { ...entry, sessionId: "old" },
    { ...entry, agentId: "other" },
    { ...entry, sessionKey: "agent:main:child" },
    {
      ...entry,
      initiatingPersonalOperator: undefined,
      requester: { connectionId: "same-device", deviceId: "same-device" },
    },
  ]) {
    expect(canRequesterAbortChatRun(changed, requester)).toBe(false);
  }
});
