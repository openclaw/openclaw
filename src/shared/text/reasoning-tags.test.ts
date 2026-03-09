import { describe, expect, it } from "vitest";
import { createStreamingThinkingFilter, stripReasoningTagsFromText } from "./reasoning-tags.js";

describe("stripReasoningTagsFromText", () => {
  describe("basic functionality", () => {
    it("returns text unchanged when no reasoning tags present", () => {
      const input = "Hello, this is a normal message.";
      expect(stripReasoningTagsFromText(input)).toBe(input);
    });

    it("strips reasoning-tag variants", () => {
      const cases = [
        {
          name: "strips proper think tags",
          input: "Hello <think>internal reasoning</think> world!",
          expected: "Hello  world!",
        },
        {
          name: "strips thinking tags",
          input: "Before <thinking>some thought</thinking> after",
          expected: "Before  after",
        },
        { name: "strips thought tags", input: "A <thought>hmm</thought> B", expected: "A  B" },
        {
          name: "strips antthinking tags",
          input: "X <antthinking>internal</antthinking> Y",
          expected: "X  Y",
        },
      ] as const;
      for (const { name, input, expected } of cases) {
        expect(stripReasoningTagsFromText(input), name).toBe(expected);
      }
    });

    it("strips multiple reasoning blocks", () => {
      const input = "<think>first</think>A<think>second</think>B";
      expect(stripReasoningTagsFromText(input)).toBe("AB");
    });
  });

  describe("code block preservation (issue #3952)", () => {
    it("preserves tags inside code examples", () => {
      const cases = [
        "Use the tag like this:\n```\n<think>reasoning</think>\n```\nThat's it!",
        "The `<think>` tag is used for reasoning. Don't forget the closing `</think>` tag.",
        "Example:\n```xml\n<think>\n  <thought>nested</thought>\n</think>\n```\nDone!",
        "Use `<think>` to open and `</think>` to close.",
        "Example:\n```\n<think>reasoning</think>\n```",
        "Use `<final>` for final answers in code: ```\n<final>42</final>\n```",
        "First `<think>` then ```\n<thinking>block</thinking>\n``` then `<thought>`",
      ] as const;
      for (const input of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(input);
      }
    });

    it("handles mixed code-tag and real-tag content", () => {
      const cases = [
        {
          input: "<think>hidden</think>Visible text with `<think>` example.",
          expected: "Visible text with `<think>` example.",
        },
        {
          input: "```\n<think>code</think>\n```\n<think>real hidden</think>visible",
          expected: "```\n<think>code</think>\n```\nvisible",
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });
  });

  describe("edge cases", () => {
    it("handles malformed tags and null-ish inputs", () => {
      const cases = [
        {
          input: "Here is how to use <think tags in your code",
          expected: "Here is how to use <think tags in your code",
        },
        {
          input: "You can start with <think and then close with </think>",
          expected: "You can start with <think and then close with",
        },
        {
          input: "A < think >content< /think > B",
          expected: "A  B",
        },
        {
          input: "",
          expected: "",
        },
        {
          input: null as unknown as string,
          expected: null,
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });

    it("handles fenced and inline code edge behavior", () => {
      const cases = [
        {
          input: "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
          expected: "Example:\n~~~\n<think>reasoning</think>\n~~~\nDone!",
        },
        {
          input: "Example:\n~~~js\n<think>code</think>\n~~~",
          expected: "Example:\n~~~js\n<think>code</think>\n~~~",
        },
        {
          input: "Use ``code`` with <think>hidden</think> text",
          expected: "Use ``code`` with  text",
        },
        {
          input: "Before\n```\ncode\n```\nAfter with <think>hidden</think>",
          expected: "Before\n```\ncode\n```\nAfter with",
        },
        {
          input: "```\n<think>not protected\n~~~\n</think>text",
          expected: "```\n<think>not protected\n~~~\n</think>text",
        },
        {
          input: "Start `unclosed <think>hidden</think> end",
          expected: "Start `unclosed  end",
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });

    it("handles nested and final tag behavior", () => {
      const cases = [
        {
          input: "<think>outer <think>inner</think> still outer</think>visible",
          expected: "still outervisible",
        },
        {
          input: "A<final>1</final>B<final>2</final>C",
          expected: "A1B2C",
        },
        {
          input: "`<final>` in code, <final>visible</final> outside",
          expected: "`<final>` in code, visible outside",
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });

    it("handles unicode, attributes, and case-insensitive tag names", () => {
      const cases = [
        {
          input: "你好 <think>思考 🤔</think> 世界",
          expected: "你好  世界",
        },
        {
          input: "A <think id='test' class=\"foo\">hidden</think> B",
          expected: "A  B",
        },
        {
          input: "A <THINK>hidden</THINK> <Thinking>also hidden</Thinking> B",
          expected: "A   B",
        },
      ] as const;
      for (const { input, expected } of cases) {
        expect(stripReasoningTagsFromText(input)).toBe(expected);
      }
    });

    it("handles long content and pathological backtick patterns efficiently", () => {
      const longContent = "x".repeat(10000);
      expect(stripReasoningTagsFromText(`<think>${longContent}</think>visible`)).toBe("visible");

      const pathological = "`".repeat(100) + "<think>test</think>" + "`".repeat(100);
      const start = Date.now();
      stripReasoningTagsFromText(pathological);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe("strict vs preserve mode", () => {
    it("applies strict and preserve modes to unclosed tags", () => {
      const input = "Before <think>unclosed content after";
      const cases = [
        { mode: "strict" as const, expected: "Before" },
        { mode: "preserve" as const, expected: "Before unclosed content after" },
      ];
      for (const { mode, expected } of cases) {
        expect(stripReasoningTagsFromText(input, { mode })).toBe(expected);
      }
    });
  });

  describe("trim options", () => {
    it("applies configured trim strategies", () => {
      const cases = [
        {
          input: "  <think>x</think>  result  <think>y</think>  ",
          expected: "result",
          opts: undefined,
        },
        {
          input: "  <think>x</think>  result  ",
          expected: "    result  ",
          opts: { trim: "none" as const },
        },
        {
          input: "  <think>x</think>  result  ",
          expected: "result  ",
          opts: { trim: "start" as const },
        },
      ] as const;
      for (const testCase of cases) {
        expect(stripReasoningTagsFromText(testCase.input, testCase.opts)).toBe(testCase.expected);
      }
    });
  });
});

describe("createStreamingThinkingFilter", () => {
  it("passes through text with no thinking tags", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("Hello ")).toBe("Hello ");
    expect(f.filter("world")).toBe("world");
  });

  it("suppresses content between streamed <think> and </think> tags", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("<think>")).toBe("");
    expect(f.filter("some reasoning")).toBe("");
    expect(f.filter("more reasoning")).toBe("");
    expect(f.filter("</think>Answer")).toBe("Answer");
  });

  it("suppresses content between <thinking> and </thinking> tags", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("<thinking>")).toBe("");
    expect(f.filter("reasoning")).toBe("");
    expect(f.filter("</thinking>Result")).toBe("Result");
  });

  it("handles opening tag and content in a single chunk", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("<think>reasoning</think>visible")).toBe("visible");
  });

  it("handles multiple thinking blocks across chunks", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("A")).toBe("A");
    expect(f.filter("<think>")).toBe("");
    expect(f.filter("hidden")).toBe("");
    expect(f.filter("</think>B")).toBe("B");
    expect(f.filter("<think>")).toBe("");
    expect(f.filter("also hidden")).toBe("");
    expect(f.filter("</think>C")).toBe("C");
  });

  it("preserves text before an opening tag in the same chunk", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("before<think>hidden")).toBe("before");
    expect(f.filter("</think>after")).toBe("after");
  });

  it("handles tag split across two chunks", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("text<thi")).toBe("text");
    expect(f.filter("nk>reasoning")).toBe("");
    expect(f.filter("</think>done")).toBe("done");
  });

  it("handles closing tag split across chunks", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("<think>hidden")).toBe("");
    expect(f.filter("</thi")).toBe("");
    expect(f.filter("nk>visible")).toBe("visible");
  });

  it("resets state correctly", () => {
    const f = createStreamingThinkingFilter();
    f.filter("<think>hidden");
    f.reset();
    expect(f.filter("visible after reset")).toBe("visible after reset");
  });

  it("handles antthinking tags", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("<antthinking>")).toBe("");
    expect(f.filter("internal")).toBe("");
    expect(f.filter("</antthinking>output")).toBe("output");
  });

  it("handles thought tags", () => {
    const f = createStreamingThinkingFilter();
    expect(f.filter("<thought>")).toBe("");
    expect(f.filter("hmm")).toBe("");
    expect(f.filter("</thought>answer")).toBe("answer");
  });

  it("handles inline thinking with leading newline preserved", () => {
    const f = createStreamingThinkingFilter();
    // Simulates the P2 scenario: delta with leading newline + thinking tags
    expect(f.filter("\n<think>reasoning</think>After tool call")).toBe("\nAfter tool call");
  });

  describe("code-fence preservation", () => {
    it("preserves think tags inside triple-backtick code fences", () => {
      const f = createStreamingThinkingFilter();
      expect(f.filter("Example:\n")).toBe("Example:\n");
      expect(f.filter("```\n")).toBe("```\n");
      expect(f.filter("<think>literal</think>\n")).toBe("<think>literal</think>\n");
      expect(f.filter("```\n")).toBe("```\n");
      expect(f.filter("Done!")).toBe("Done!");
    });

    it("preserves think tags inside triple-tilde code fences", () => {
      const f = createStreamingThinkingFilter();
      expect(f.filter("~~~\n")).toBe("~~~\n");
      expect(f.filter("<think>code</think>\n")).toBe("<think>code</think>\n");
      expect(f.filter("~~~\n")).toBe("~~~\n");
      expect(f.filter("visible")).toBe("visible");
    });

    it("preserves think tags inside fenced code with language tag", () => {
      const f = createStreamingThinkingFilter();
      expect(f.filter("```html\n")).toBe("```html\n");
      expect(f.filter("<think>literal</think>\n")).toBe("<think>literal</think>\n");
      expect(f.filter("```\n")).toBe("```\n");
    });

    it("still strips real think tags outside code fences", () => {
      const f = createStreamingThinkingFilter();
      // Send code fence content in separate chunks (realistic streaming)
      expect(f.filter("```\n")).toBe("```\n");
      expect(f.filter("<think>preserved</think>\n")).toBe("<think>preserved</think>\n");
      expect(f.filter("```\n")).toBe("```\n");
      // Now outside the fence, real think tags should be stripped
      expect(f.filter("<think>")).toBe("");
      expect(f.filter("hidden")).toBe("");
      expect(f.filter("</think>visible")).toBe("visible");
    });

    it("handles code fence split across chunks", () => {
      const f = createStreamingThinkingFilter();
      // Fence opener arrives as a complete line in its own chunk
      expect(f.filter("text\n")).toBe("text\n");
      expect(f.filter("```\n")).toBe("```\n");
      // Now inside fence — think tags should be preserved
      expect(f.filter("<think>inside fence</think>\n")).toBe("<think>inside fence</think>\n");
      expect(f.filter("```\n")).toBe("```\n");
      // Now outside fence, think tags should be stripped
      expect(f.filter("<think>hidden</think>after")).toBe("after");
    });

    it("preserves think tags in single-chunk code fence", () => {
      const f = createStreamingThinkingFilter();
      const input = "```\n<think>literal</think>\n```\n";
      expect(f.filter(input)).toBe(input);
    });

    it("preserves think tags in single-chunk fence then strips outside", () => {
      const f = createStreamingThinkingFilter();
      expect(f.filter("```\n<think>literal</think>\n```\n")).toBe(
        "```\n<think>literal</think>\n```\n",
      );
      expect(f.filter("<think>hidden</think>visible")).toBe("visible");
    });

    it("resets code fence state on reset()", () => {
      const f = createStreamingThinkingFilter();
      f.filter("```\n");
      f.reset();
      // After reset, should not think we're in a code fence
      expect(f.filter("<think>hidden</think>visible")).toBe("visible");
    });
  });
});
