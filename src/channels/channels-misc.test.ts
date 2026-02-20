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
  it("normalizes common inputs", () => {
    expect(normalizeChatType("direct")).toBe("direct");
    expect(normalizeChatType("dm")).toBe("direct");
    expect(normalizeChatType("group")).toBe("group");
    expect(normalizeChatType("channel")).toBe("channel");
  });

  it("returns undefined for empty/unknown values", () => {
    expect(normalizeChatType(undefined)).toBeUndefined();
    expect(normalizeChatType("")).toBeUndefined();
    expect(normalizeChatType("nope")).toBeUndefined();
    expect(normalizeChatType("room")).toBeUndefined();
  });

  describe("backward compatibility", () => {
    it("accepts legacy 'dm' value and normalizes to 'direct'", () => {
      // Legacy config/input may use "dm" - ensure smooth upgrade path
      expect(normalizeChatType("dm")).toBe("direct");
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
