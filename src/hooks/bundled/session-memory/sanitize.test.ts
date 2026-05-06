import { describe, expect, it } from "vitest";
import { ELIDED_TURN_MARKER, sanitizeAssistantContent } from "./sanitize.js";

describe("sanitizeAssistantContent", () => {
  it("strips <|im_end|> and <|im_start|> chat template tokens", () => {
    const input =
      "<|im_start|>Hello, world. This is a longer legit response with enough content to survive the short-turn heuristic.<|im_end|>";
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe(
      "Hello, world. This is a longer legit response with enough content to survive the short-turn heuristic.",
    );
    expect(result.skipped).toBe(false);
  });

  it("strips <|endoftext|>, <|eot_id|>, and bos/eos markers", () => {
    const input =
      "<bos>hello<|endoftext|> world<|eot_id|><|begin_of_text|> ok <eos><|end_of_text|> and still plenty of legit content remaining to avoid the elision heuristic.";
    const result = sanitizeAssistantContent(input);
    expect(result.text).not.toContain("<|");
    expect(result.text).not.toContain("<bos>");
    expect(result.text).not.toContain("<eos>");
    expect(result.text).toContain("hello");
    expect(result.text).toContain("world");
    expect(result.text).toContain("ok");
    expect(result.skipped).toBe(false);
  });

  it("strips raw <tool_call>...</tool_call> XML blocks including multiline and multi-per-line", () => {
    const multiline = [
      "before",
      "<tool_call>",
      "<function=x>",
      "<parameter=y>",
      "z",
      "</parameter>",
      "</function>",
      "</tool_call>",
      "after",
    ].join("\n");
    const multilineResult = sanitizeAssistantContent(multiline);
    expect(multilineResult.text).toContain("before");
    expect(multilineResult.text).toContain("after");
    expect(multilineResult.text).not.toContain("<tool_call>");
    expect(multilineResult.text).not.toContain("<function=x>");

    const twoOnOneLine =
      "pre <tool_call><function=a></function></tool_call> mid <tool_call><function=b></function></tool_call> post";
    const twoResult = sanitizeAssistantContent(twoOnOneLine);
    expect(twoResult.text).toBe("pre  mid  post");
  });

  it("strips an unclosed <tool_call> block that lost its closing tag mid-stream", () => {
    // Mid-stream truncation: the model started emitting a tool_call but the
    // stream cut before `</tool_call>`. Without the unclosed-block branch in
    // the regex, the fragment used to be persisted verbatim and re-injected
    // as scaffolding on the next /new.
    const input = [
      "This was a substantive response that should be preserved well above the short-turn elision threshold.",
      "<tool_call>",
      "<function=foo>",
      "<parameter=bar>",
      "baz",
    ].join("\n");
    const result = sanitizeAssistantContent(input);
    expect(result.text).not.toContain("<tool_call>");
    expect(result.text).not.toContain("<function=foo>");
    expect(result.text).not.toContain("<parameter=bar>");
    expect(result.text).toContain("substantive response");
    expect(result.skipped).toBe(false);
  });

  it("strips an unclosed <tool_call> with no preceding content (whole turn is the fragment)", () => {
    const input = "<tool_call>\n<function=foo>\n";
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe("");
    expect(result.skipped).toBe(true);
  });

  it("prefers the closing tag over the open-ended branch when both are available", () => {
    // First non-greedy alternative must win so trailing legit content after
    // a properly-closed block is preserved instead of being eaten by the
    // open-ended fallback.
    const input =
      "<tool_call><function=a></function></tool_call>This trailing prose has plenty of substance to remain after sanitization, well past the short-turn threshold.";
    const result = sanitizeAssistantContent(input);
    expect(result.text).toContain("trailing prose");
    expect(result.text).not.toContain("<tool_call>");
    expect(result.text).not.toContain("<function=a>");
  });

  it("strips orphaned role-label-only lines", () => {
    const input = ["This is a real reply.", "assistant:", "user", "system: ", "Another line."].join(
      "\n",
    );
    const result = sanitizeAssistantContent(input);
    expect(result.text).toContain("This is a real reply.");
    expect(result.text).toContain("Another line.");
    expect(result.text).not.toMatch(/^assistant:\s*$/m);
    expect(result.text).not.toMatch(/^user\s*$/m);
    expect(result.text).not.toMatch(/^system:\s*$/m);
  });

  it("preserves legit content mentioning roles in prose", () => {
    const input = "The assistant then replied, and the user: asked another question.";
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe(input);
    expect(result.skipped).toBe(false);
  });

  it("marks a turn as skipped when cleaned content is empty", () => {
    const input = "<|im_start|><|im_end|><|endoftext|>";
    const result = sanitizeAssistantContent(input);
    expect(result.skipped).toBe(true);
  });

  it("marks a turn as skipped when cleaned content is only NO_REPLY", () => {
    expect(sanitizeAssistantContent("NO_REPLY").skipped).toBe(true);
    expect(sanitizeAssistantContent("no_reply").skipped).toBe(true);
    expect(sanitizeAssistantContent("  NO_REPLY  ").skipped).toBe(true);
    expect(sanitizeAssistantContent("<|im_end|>NO_REPLY<|im_end|>").skipped).toBe(true);
  });

  it("marks a turn as skipped when >50% was stripped and remainder is short", () => {
    const tokens = "<|im_end|>".repeat(60); // 600 chars of tokens
    const input = `${tokens}hi`;
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe("hi");
    expect(result.strippedRatio).toBeGreaterThan(0.5);
    expect(result.skipped).toBe(true);
  });

  it("does NOT mark long legit content as skipped even with a few tokens", () => {
    const paragraph = "This is a thoughtful paragraph of legitimate content. ".repeat(40); // ~2200 chars
    const input = `${paragraph}<|im_end|>`;
    const result = sanitizeAssistantContent(input);
    expect(result.skipped).toBe(false);
    expect(result.text).not.toContain("<|im_end|>");
    expect(result.text.length).toBeGreaterThan(1000);
    expect(result.text).toContain("thoughtful paragraph");
  });

  it("strippedRatio is not inflated by blank-line collapse or trim", () => {
    // The body is wrapped in leading/trailing whitespace and contains a run
    // of blank lines. Phase 2 (blank-line collapse + trim) shrinks the
    // string further, but the ratio is measured against the post-token-strip
    // intermediate length, not the final cleaned length, so a clean payload
    // surrounded by cosmetic whitespace must report a 0 ratio.
    const body = "This is a perfectly legitimate paragraph of content.";
    const input = `\n\n\n\n${body}\n\n\n\n`;
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe(body);
    expect(result.strippedRatio).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it("is a no-op on clean markdown content", () => {
    const input = [
      "# Heading",
      "",
      "Some **bold** text and a [link](https://example.com).",
      "",
      "- item 1",
      "- item 2",
    ].join("\n");
    const result = sanitizeAssistantContent(input);
    expect(result.text).toBe(input);
    expect(result.skipped).toBe(false);
    expect(result.strippedRatio).toBe(0);
  });

  it("exports the elided-turn marker for caller use", () => {
    expect(ELIDED_TURN_MARKER).toBe("[malformed turn elided]");
  });
});
