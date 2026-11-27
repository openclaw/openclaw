import { expect, it } from "vitest";
import { createTestOperatorAuthority } from "../agents/admitted-run-context.test-support.js";
import { canRequesterAbortChatRun } from "./server-methods/chat-abort-authorization.js";

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
