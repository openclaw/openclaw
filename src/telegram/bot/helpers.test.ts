import { describe, expect, it } from "vitest";
import { buildTelegramThreadParams, buildTypingThreadParams } from "./helpers.js";

describe("buildTelegramThreadParams", () => {
  it("omits General topic thread id for message sends", () => {
    expect(buildTelegramThreadParams(1)).toBeUndefined();
  });

  it("includes non-General topic thread ids", () => {
    expect(buildTelegramThreadParams(99)).toEqual({ message_thread_id: 99 });
  });

  it("normalizes thread ids to integers", () => {
    expect(buildTelegramThreadParams(42.9)).toEqual({ message_thread_id: 42 });
  });
});

describe("buildTypingThreadParams", () => {
  it("returns undefined when no thread id is provided", () => {
    expect(buildTypingThreadParams(undefined)).toBeUndefined();
  });

  it("includes General topic thread id for typing indicators", () => {
    expect(buildTypingThreadParams(1)).toEqual({ message_thread_id: 1 });
  });

  it("normalizes thread ids to integers", () => {
    expect(buildTypingThreadParams(42.9)).toEqual({ message_thread_id: 42 });
  });
});
