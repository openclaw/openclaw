import { describe, expect, it } from "vitest";
import {
  createActionGate,
  readNumberParam,
  readReactionParams,
  readStringOrNumberParam,
} from "./common.js";

type TestActions = {
  reactions?: boolean;
  messages?: boolean;
};

describe("createActionGate", () => {
  it("defaults to enabled when unset", () => {
    const gate = createActionGate<TestActions>(undefined);
    expect(gate("reactions")).toBe(true);
    expect(gate("messages", false)).toBe(false);
  });

  it("respects explicit false", () => {
    const gate = createActionGate<TestActions>({ reactions: false });
    expect(gate("reactions")).toBe(false);
    expect(gate("messages")).toBe(true);
  });
});

describe("readStringOrNumberParam", () => {
  it("returns numeric strings for numbers", () => {
    const params = { chatId: 123 };
    expect(readStringOrNumberParam(params, "chatId")).toBe("123");
  });

  it("trims strings", () => {
    const params = { chatId: "  abc  " };
    expect(readStringOrNumberParam(params, "chatId")).toBe("abc");
  });

  it("accepts snake_case aliases for camelCase keys", () => {
    const params = { chat_id: "123" };
    expect(readStringOrNumberParam(params, "chatId")).toBe("123");
  });
});

describe("readNumberParam", () => {
  it("parses numeric strings", () => {
    const params = { messageId: "42" };
    expect(readNumberParam(params, "messageId")).toBe(42);
  });

  it("truncates when integer is true", () => {
    const params = { messageId: "42.9" };
    expect(readNumberParam(params, "messageId", { integer: true })).toBe(42);
  });

  it("accepts snake_case aliases for camelCase keys", () => {
    const params = { message_id: "42" };
    expect(readNumberParam(params, "messageId")).toBe(42);
  });
});

describe("required parameter validation", () => {
  it("throws when required values are missing", () => {
    expect(() => readStringOrNumberParam({}, "chatId", { required: true })).toThrow(
      /chatId required/,
    );
    expect(() => readNumberParam({}, "messageId", { required: true })).toThrow(
      /messageId required/,
    );
  });
});

describe("readReactionParams", () => {
  it("allows empty emoji for removal semantics", () => {
    const params = { emoji: "" };
    const result = readReactionParams(params, {
      removeErrorMessage: "Emoji is required",
    });
    expect(result.isEmpty).toBe(true);
    expect(result.remove).toBe(false);
  });

  it("throws when remove true but emoji empty", () => {
    const params = { emoji: "", remove: true };
    expect(() =>
      readReactionParams(params, {
        removeErrorMessage: "Emoji is required",
      }),
    ).toThrow(/Emoji is required/);
  });

  it("passes through remove flag", () => {
    const params = { emoji: "✅", remove: true };
    const result = readReactionParams(params, {
      removeErrorMessage: "Emoji is required",
    });
    expect(result.remove).toBe(true);
    expect(result.emoji).toBe("✅");
  });
});
