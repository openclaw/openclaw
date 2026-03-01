import { describe, it, expect } from "vitest";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";

describe("assertFeishuMessageApiSuccess", () => {
  it("does not throw on code 0", () => {
    expect(() => assertFeishuMessageApiSuccess({ code: 0 }, "test")).not.toThrow();
  });

  it("throws with msg on non-zero code", () => {
    expect(() =>
      assertFeishuMessageApiSuccess({ code: 99991672, msg: "permission denied" }, "Feishu"),
    ).toThrow("Feishu: permission denied");
  });

  it("throws with code fallback when msg is empty", () => {
    expect(() => assertFeishuMessageApiSuccess({ code: 500 }, "Feishu")).toThrow(
      "Feishu: code 500",
    );
  });
});

describe("toFeishuSendResult", () => {
  it("extracts message_id from response", () => {
    const result = toFeishuSendResult({ code: 0, data: { message_id: "om_abc" } }, "oc_chat");
    expect(result).toEqual({ messageId: "om_abc", chatId: "oc_chat" });
  });

  it("defaults messageId to 'unknown' when missing", () => {
    const result = toFeishuSendResult({ code: 0, data: {} }, "oc_chat");
    expect(result.messageId).toBe("unknown");
  });
});
