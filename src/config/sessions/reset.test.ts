import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { isThreadSessionKey, resolveSessionResetType } from "./reset.js";

describe("session reset thread detection", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

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

  it("prefers typed session metadata over session-key shape for group resets", () => {
    expect(
      resolveSessionResetType({
        sessionKey: "agent:main:main",
        sessionScope: "channel",
        chatType: "channel",
      }),
    ).toBe("group");
  });

  it("keeps shared-main direct sessions direct even when the key is generic", () => {
    expect(
      resolveSessionResetType({
        sessionKey: "agent:main:main",
        sessionScope: "shared-main",
        chatType: "direct",
      }),
    ).toBe("direct");
  });
});
