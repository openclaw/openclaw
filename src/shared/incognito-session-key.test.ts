import { describe, expect, it } from "vitest";
import { isIncognitoSessionKey } from "./incognito-session-key.js";

describe("isIncognitoSessionKey", () => {
  it.each([
    "agent:main:dashboard:incognito-123",
    "AGENT:MAIN:SUBAGENT:INCOGNITO-123",
    "agent:main:internal-session-effects:incognito-123",
    "agent:main:setup-inference:incognito-probe-setup-inference-123",
  ])("recognizes %s", (sessionKey) => {
    expect(isIncognitoSessionKey(sessionKey)).toBe(true);
  });

  it.each([
    undefined,
    "",
    "dashboard:incognito-123",
    "agent:main:dashboard:regular-123",
    "agent:main:setup-inference:regular-123",
    "agent::dashboard:incognito-123",
  ])("rejects %s", (sessionKey) => {
    expect(isIncognitoSessionKey(sessionKey)).toBe(false);
  });
});
