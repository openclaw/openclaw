import { describe, expect, it } from "vitest";
import * as channelWeb from "../channel-web.js";
import { normalizeChatType } from "./chat-type.js";
import * as webEntry from "./web/index.js";

describe("channel-web barrel", () => {
  it("exports the expected web helpers", () => {
    expect(channelWeb.createWaSocket).toBeTypeOf("function");
    expect(channelWeb.loginWeb).toBeTypeOf("function");
    expect(channelWeb.monitorWebChannel).toBeTypeOf("function");
    expect(channelWeb.sendMessageWhatsApp).toBeTypeOf("function");
    expect(channelWeb.monitorWebInbox).toBeTypeOf("function");
    expect(channelWeb.pickWebChannel).toBeTypeOf("function");
    expect(channelWeb.WA_WEB_AUTH_DIR).toBeTruthy();
  });
});

describe("normalizeChatType", () => {
  const cases: Array<{ name: string; value: string | undefined; expected: string | undefined }> = [
    { name: "normalizes direct", value: "direct", expected: "direct" },
    { name: "normalizes dm alias", value: "dm", expected: "direct" },
    { name: "normalizes group", value: "group", expected: "group" },
    { name: "normalizes channel", value: "channel", expected: "channel" },
    { name: "returns undefined for undefined", value: undefined, expected: undefined },
    { name: "returns undefined for empty", value: "", expected: undefined },
    { name: "returns undefined for unknown value", value: "nope", expected: undefined },
    { name: "returns undefined for unsupported room", value: "room", expected: undefined },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(normalizeChatType(testCase.value)).toBe(testCase.expected);
    });
  }

  describe("backward compatibility", () => {
    it("accepts legacy 'dm' value shape variants and normalizes to 'direct'", () => {
      // Legacy config/input may use "dm" with non-canonical casing/spacing.
      expect(normalizeChatType("DM")).toBe("direct");
      expect(normalizeChatType(" dm ")).toBe("direct");
    });
  });
});

describe("channels/web entrypoint", () => {
  it("re-exports web channel helpers", () => {
    expect(webEntry.createWaSocket).toBe(channelWeb.createWaSocket);
    expect(webEntry.loginWeb).toBe(channelWeb.loginWeb);
    expect(webEntry.logWebSelfId).toBe(channelWeb.logWebSelfId);
    expect(webEntry.monitorWebInbox).toBe(channelWeb.monitorWebInbox);
    expect(webEntry.monitorWebChannel).toBe(channelWeb.monitorWebChannel);
    expect(webEntry.pickWebChannel).toBe(channelWeb.pickWebChannel);
    expect(webEntry.sendMessageWhatsApp).toBe(channelWeb.sendMessageWhatsApp);
    expect(webEntry.WA_WEB_AUTH_DIR).toBe(channelWeb.WA_WEB_AUTH_DIR);
    expect(webEntry.waitForWaConnection).toBe(channelWeb.waitForWaConnection);
    expect(webEntry.webAuthExists).toBe(channelWeb.webAuthExists);
  });
});
