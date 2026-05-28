import { describe, expect, it } from "vitest";
import {
  createActionGate,
  readPositiveIntegerParam,
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
});

describe("readNumberParam", () => {
  it("parses numeric strings", () => {
    const params = { messageId: "42" };
    expect(readNumberParam(params, "messageId")).toBe(42);
  });

  it("keeps partial parse behavior by default", () => {
    const params = { messageId: "42abc" };
    expect(readNumberParam(params, "messageId")).toBe(42);
  });

  it("rejects partial numeric strings when strict is enabled", () => {
    const params = { messageId: "42abc" };
    expect(readNumberParam(params, "messageId", { strict: true })).toBeUndefined();
  });

  it("truncates when integer is true", () => {
    const params = { messageId: "42.9" };
    expect(readNumberParam(params, "messageId", { integer: true })).toBe(42);
  });

  it("accepts only positive safe integers when positiveInteger is true", () => {
    expect(readNumberParam({ tokenBudget: "42" }, "tokenBudget", { positiveInteger: true })).toBe(
      42,
    );
    expect(
      readNumberParam({ tokenBudget: "42.9" }, "tokenBudget", { positiveInteger: true }),
    ).toBeUndefined();
    expect(
      readNumberParam({ tokenBudget: 0 }, "tokenBudget", { positiveInteger: true }),
    ).toBeUndefined();
    expect(
      readNumberParam({ tokenBudget: Number.POSITIVE_INFINITY }, "tokenBudget", {
        positiveInteger: true,
      }),
    ).toBeUndefined();
  });

  it("accepts only nonnegative safe integers when nonNegativeInteger is true", () => {
    expect(readNumberParam({ cacheAge: 0 }, "cacheAge", { nonNegativeInteger: true })).toBe(0);
    expect(readNumberParam({ cacheAge: "42" }, "cacheAge", { nonNegativeInteger: true })).toBe(42);
    expect(
      readNumberParam({ cacheAge: "42.9" }, "cacheAge", { nonNegativeInteger: true }),
    ).toBeUndefined();
    expect(
      readNumberParam({ cacheAge: -1 }, "cacheAge", { nonNegativeInteger: true }),
    ).toBeUndefined();
    expect(
      readNumberParam({ cacheAge: Number.POSITIVE_INFINITY }, "cacheAge", {
        nonNegativeInteger: true,
      }),
    ).toBeUndefined();
  });

  it("throws for invalid present positive integer params", () => {
    expect(readPositiveIntegerParam({ timeoutMs: "42" }, "timeoutMs")).toBe(42);
    expect(readPositiveIntegerParam({ timeoutMs: null }, "timeoutMs")).toBeUndefined();
    expect(() => readPositiveIntegerParam({ timeoutMs: "42.5" }, "timeoutMs")).toThrow(
      "timeoutMs must be a positive integer",
    );
    expect(() =>
      readPositiveIntegerParam({ timeoutMs: 0 }, "timeoutMs", {
        message: "timeoutMs must be a positive integer in milliseconds.",
      }),
    ).toThrow("timeoutMs must be a positive integer in milliseconds.");
    expect(() =>
      readPositiveIntegerParam({ maxResults: 21 }, "maxResults", {
        max: 20,
        message: "maxResults must be an integer from 1 to 20",
      }),
    ).toThrow("maxResults must be an integer from 1 to 20");
  });
});

describe("snake_case aliases", () => {
  it.each([
    {
      name: "string-or-number reader",
      read: () => readStringOrNumberParam({ chat_id: "123" }, "chatId"),
      expected: "123",
    },
    {
      name: "number reader",
      read: () => readNumberParam({ message_id: "42" }, "messageId"),
      expected: 42,
    },
  ])("accepts snake_case aliases for camelCase keys in $name", ({ read, expected }) => {
    expect(read()).toBe(expected);
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
