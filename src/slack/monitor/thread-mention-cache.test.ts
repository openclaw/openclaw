import { afterEach, describe, expect, it } from "vitest";
import {
  _clearThreadMentionCache,
  recordThreadMention,
  wasThreadRootMentioned,
} from "./thread-mention-cache.js";

afterEach(() => {
  _clearThreadMentionCache();
});

describe("thread-mention-cache", () => {
  it("returns false for unknown threads", () => {
    expect(wasThreadRootMentioned("C123", "1234.5678")).toBe(false);
  });

  it("returns true after recording a mention", () => {
    recordThreadMention("C123", "1234.5678");
    expect(wasThreadRootMentioned("C123", "1234.5678")).toBe(true);
  });

  it("isolates by channel + thread", () => {
    recordThreadMention("C123", "1234.5678");
    expect(wasThreadRootMentioned("C999", "1234.5678")).toBe(false);
    expect(wasThreadRootMentioned("C123", "9999.0000")).toBe(false);
  });

  it("clears cache via _clearThreadMentionCache", () => {
    recordThreadMention("C123", "1234.5678");
    _clearThreadMentionCache();
    expect(wasThreadRootMentioned("C123", "1234.5678")).toBe(false);
  });
});
