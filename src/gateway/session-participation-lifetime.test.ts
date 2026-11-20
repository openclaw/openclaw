import { expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { canRequesterAbortChatRun } from "./server-methods/chat-abort-authorization.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import {
  retainSessionParticipation,
  revokeSessionParticipation,
} from "./session-participation-lifetime.js";

it("keeps inherited invocation custody through retention and authorized incarnation rollover", async () => {
  const target = {
    profileId: "participant",
    agentId: "main",
    sessionKey: "agent:main:scope",
    sessionId: "before",
  };
  const lifetime = retainSessionParticipation(target);
  const released = vi.fn(lifetime.release);
  const inherited = createAdmittedRunOperatorAuthority({
    profileId: target.profileId,
    scopes: ["operator.sessions.read"],
    assertCurrent() {},
  });
  const captured = await captureGatewayOperatorRunAuthority({
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
  revokeSessionParticipation(target);
  expect(captured?.authority.signal?.aborted).toBe(false);
  revokeSessionParticipation({ ...target, sessionId: "after" });
  expect(captured?.authority.signal?.aborted).toBe(true);
  expect(() => captured?.authority.assertCurrent()).toThrow();
  lifetime.followIncarnation("after", "reinvited");
  expect(lifetime.signal.aborted).toBe(true);
  releaseRetained?.();
  expect(released).toHaveBeenCalledTimes(1);
});

it("participant Stop follows the original profile and exact target, never a matching transport", () => {
  const target = { agentId: "main", sessionKey: "agent:main:scope", sessionId: "current" };
  const initiator = createAdmittedRunOperatorAuthority({
    profileId: "participant",
    scopes: [],
    assertCurrent() {},
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
