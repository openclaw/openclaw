import { describe, expect, it } from "vitest";
import { buildDeliveryEchoScope, buildIMessageEchoScope } from "./echo-scope.js";

describe("buildIMessageEchoScope", () => {
  it("builds DM scope with imessage: prefix", () => {
    expect(
      buildIMessageEchoScope({
        accountId: "default",
        isGroup: false,
        sender: "+15551234567",
      }),
    ).toBe("default:imessage:+15551234567");
  });

  it("builds group scope with chat_id: prefix", () => {
    expect(
      buildIMessageEchoScope({
        accountId: "default",
        isGroup: true,
        chatId: 42,
        sender: "+15551234567",
      }),
    ).toBe("default:chat_id:42");
  });

  it("handles missing chatId in group", () => {
    expect(
      buildIMessageEchoScope({
        accountId: "acct-1",
        isGroup: true,
        sender: "+15551234567",
      }),
    ).toBe("acct-1:");
  });
});

describe("buildDeliveryEchoScope", () => {
  it("builds scope from accountId and target", () => {
    expect(buildDeliveryEchoScope("default", "imessage:+15551234567")).toBe(
      "default:imessage:+15551234567",
    );
  });

  it("builds group scope from accountId and chat_id target", () => {
    expect(buildDeliveryEchoScope("default", "chat_id:42")).toBe("default:chat_id:42");
  });
});

describe("scope consistency between inbound and delivery", () => {
  it("DM scopes match when target uses imessage:{sender} format", () => {
    const sender = "+15551234567";
    const accountId = "default";

    const inboundScope = buildIMessageEchoScope({
      accountId,
      isGroup: false,
      sender,
    });
    const deliveryScope = buildDeliveryEchoScope(accountId, `imessage:${sender}`);

    expect(deliveryScope).toBe(inboundScope);
  });

  it("group scopes match when target uses chat_id:{id} format", () => {
    const chatId = 99;
    const accountId = "acct-2";

    const inboundScope = buildIMessageEchoScope({
      accountId,
      isGroup: true,
      chatId,
      sender: "+15551234567",
    });
    const deliveryScope = buildDeliveryEchoScope(accountId, `chat_id:${chatId}`);

    expect(deliveryScope).toBe(inboundScope);
  });
});
