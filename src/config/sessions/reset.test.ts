import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { resolveSessionResetType, resolveThreadFlag } from "./reset.js";

describe("session reset thread detection", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it("uses explicit group metadata for conversation ids with embedded :topic:", () => {
    const sessionKey =
      "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user";
    expect(resolveSessionResetType({ sessionKey, isGroup: true })).toBe("group");
  });

  it("does not infer thread reset type from session key shape", () => {
    const sessionKey = "agent:main:telegram:group:-100123:topic:77";
    expect(resolveSessionResetType({ sessionKey })).toBe("direct");
    expect(resolveThreadFlag({ sessionKey })).toBe(false);
    expect(resolveThreadFlag({ sessionKey, messageThreadId: 77 })).toBe(true);
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
