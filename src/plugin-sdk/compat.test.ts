import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_ID,
  HEARTBEAT_TOKEN,
  SILENT_REPLY_TOKEN,
  buildRandomTempFilePath,
  extractToolSend,
  formatDocsLink,
  isNormalizedSenderAllowed,
  jsonResult,
  readStringParam,
  resolveSenderCommandAuthorization,
  resolveThreadSessionKeys,
} from "./compat.js";

describe("plugin-sdk compat exports", () => {
  it("keeps legacy channel plugin helpers available from compat", () => {
    expect(DEFAULT_ACCOUNT_ID).toBe("default");
    expect(typeof HEARTBEAT_TOKEN).toBe("string");
    expect(typeof SILENT_REPLY_TOKEN).toBe("string");
    expect(typeof buildRandomTempFilePath).toBe("function");
    expect(typeof formatDocsLink).toBe("function");
    expect(typeof isNormalizedSenderAllowed).toBe("function");
    expect(typeof jsonResult).toBe("function");
    expect(typeof readStringParam).toBe("function");
    expect(typeof resolveSenderCommandAuthorization).toBe("function");
    expect(typeof resolveThreadSessionKeys).toBe("function");
  });

  it("exports tool-send helpers through compat", () => {
    expect(extractToolSend({ action: "sendMessage", to: "chat", threadId: 42 })).toEqual({
      to: "chat",
      threadId: "42",
    });
  });
});
