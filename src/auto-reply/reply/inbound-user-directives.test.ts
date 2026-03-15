import { describe, it } from "node:test";
import assert from "node:assert";
import {
  extractInboundUserDirectives,
  hasReplyInThreadDirective,
} from "./inbound-user-directives.js";

describe("extractInboundUserDirectives", () => {
  describe("reply in thread", () => {
    it("detects 'reply in thread' at end of message", () => {
      const result = extractInboundUserDirectives("Hello world reply in thread");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello world");
    });

    it("detects 'rit' at end of message", () => {
      const result = extractInboundUserDirectives("Hello world rit");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello world");
    });

    it("detects 'thread' at end of message", () => {
      const result = extractInboundUserDirectives("Hello world thread");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello world");
    });

    it("detects 'in thread' at end of message", () => {
      const result = extractInboundUserDirectives("Hello world in thread");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello world");
    });

    it("is case-insensitive", () => {
      const result = extractInboundUserDirectives("Hello world REPLY IN THREAD");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello world");
    });

    it("handles punctuation after trigger", () => {
      const result = extractInboundUserDirectives("Hello world reply in thread!");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello world");
    });

    it("handles multiple punctuation", () => {
      const result = extractInboundUserDirectives("Hello world reply in thread!!!");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello world");
    });

    it("handles whitespace around trigger", () => {
      const result = extractInboundUserDirectives("Hello world   reply in thread   ");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello world");
    });

    it("does not trigger in middle of message", () => {
      const result = extractInboundUserDirectives("reply in thread is what I want to do");
      assert.strictEqual(result.replyInThread, false);
      assert.strictEqual(result.cleaned, "reply in thread is what I want to do");
    });

    it("does not trigger when part of a word", () => {
      const result = extractInboundUserDirectives("Hello threadworld");
      assert.strictEqual(result.replyInThread, false);
      assert.strictEqual(result.cleaned, "Hello threadworld");
    });

    it("returns empty string for empty input", () => {
      const result = extractInboundUserDirectives("");
      assert.strictEqual(result.replyInThread, false);
      assert.strictEqual(result.cleaned, "");
    });

    it("returns empty string for whitespace-only input", () => {
      const result = extractInboundUserDirectives("   ");
      assert.strictEqual(result.replyInThread, false);
      assert.strictEqual(result.cleaned, "   ");
    });

    it("handles multiline messages", () => {
      const result = extractInboundUserDirectives("Hello\nworld\nreply in thread");
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "Hello\nworld");
    });

    it("preserves message content before trigger", () => {
      const result = extractInboundUserDirectives(
        "This is a complex message with numbers 123 and symbols! rit",
      );
      assert.strictEqual(result.replyInThread, true);
      assert.strictEqual(result.cleaned, "This is a complex message with numbers 123 and symbols!");
    });
  });
});

describe("hasReplyInThreadDirective", () => {
  it("returns true for message with trigger", () => {
    assert.strictEqual(hasReplyInThreadDirective("Hello rit"), true);
  });

  it("returns false for message without trigger", () => {
    assert.strictEqual(hasReplyInThreadDirective("Hello world"), false);
  });

  it("returns false for empty string", () => {
    assert.strictEqual(hasReplyInThreadDirective(""), false);
  });
});
