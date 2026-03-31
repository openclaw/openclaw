import { describe, expect, it } from "vitest";
import { isThreadSessionKey, resolveSessionResetType } from "./reset.js";

describe("session reset thread detection", () => {
  it("does not treat feishu conversation ids with embedded :topic: as thread suffixes", () => {
    const sessionKey =
      "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user";
    expect(isThreadSessionKey(sessionKey)).toBe(false);
    expect(resolveSessionResetType({ sessionKey })).toBe("group");
  });

  it("still treats telegram :topic: suffixes as thread sessions", () => {
    const sessionKey = "agent:main:telegram:group:-100123:topic:77";
    expect(isThreadSessionKey(sessionKey)).toBe(true);
    expect(resolveSessionResetType({ sessionKey })).toBe("thread");
  });
});
