import { describe, expect, it } from "vitest";
import {
  listIncognitoSessionsForAgent,
  lookupIncognitoSessionAgentId,
  registerIncognitoSession,
  unregisterIncognitoSession,
} from "./incognito-session-registry.js";

describe("incognito session registry", () => {
  it("removes deleted sessions from enumeration while retaining their in-memory routing tombstone", () => {
    const sessionKey = "agent:main:dashboard:retired-incognito";
    registerIncognitoSession(sessionKey, "main");
    expect(listIncognitoSessionsForAgent("main")).toContain(sessionKey);

    expect(unregisterIncognitoSession(sessionKey)).toBe(true);
    expect(listIncognitoSessionsForAgent("main")).not.toContain(sessionKey);
    expect(lookupIncognitoSessionAgentId(sessionKey)).toBe("main");
  });
});
