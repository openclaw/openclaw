import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextForStreamUpdate,
  sanitizeAssistantVisibleTextWithProfile,
  stripAssistantInternalScaffolding,
} from "./assistant-visible-text.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";

describe("stripAssistantInternalScaffolding", () => {
  function expectVisibleText(input: string, expected: string) {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  }

  function createLiteralRelevantMemoriesCodeBlock() {
    return [
      "```xml",
      "<relevant-memories>",
      "sample",
      "</relevant-memories>",
      "```",
      "",
      "Visible text",
    ].join("\n");
  }

  function expectLiteralVisibleText(input: string) {
    expectVisibleText(input, input);
  }

  it.each([
    {
      name: "strips reasoning tags",
      input: ["<thinking>", "secret", "</thinking>", "Visible"].join("\n"),
      expected: "Visible",
    },
    {
      name: "strips relevant-memories scaffolding blocks",
      input: [
        "<relevant-memories>",
        "The following memories may be relevant to this conversation:",
        "- Internal memory note",
        "</relevant-memories>",
        "",
        "User-visible answer",
      ].join("\n"),
      expected: "User-visible answer",
    },
    {
      name: "supports relevant_memories tag variants",
      input: [
        "<relevant_memories>",
        "Internal memory note",
        "</relevant_memories>",
        "Visible",
      ].join("\n"),
      expected: "Visible",
    },
    {
      name: "hides unfinished relevant-memories blocks",
      input: ["Hello", "<relevant-memories>", "internal-only"].join("\n"),
      expected: "Hello\n",
    },
    {
      name: "trims leading whitespace after stripping scaffolding",
      input: [
        "<thinking>",
        "secret",
        "</thinking>",
        "   ",
        "<relevant-memories>",
        "internal note",
        "</relevant-memories>",
        "  Visible",
      ].join("\n"),
      expected: "Visible",
    },
    {
      name: "preserves unfinished reasoning text while still stripping memory blocks",
      input: [
        "Before",
        "<thinking>",
        "secret",
        "<relevant-memories>",
        "internal note",
        "</relevant-memories>",
        "After",
      ].join("\n"),
      expected: "Before\n\nsecret\n\nAfter",
    },
    {
      name: "keeps relevant-memories tags inside fenced code",
      input: createLiteralRelevantMemoriesCodeBlock(),
      expected: undefined,
    },
    {
      name: "keeps literal relevant-memories prose",
      input: "Use `<relevant-memories>example</relevant-memories>` literally.",
      expected: undefined,
    },
  ] as const)("$name", ({ input, expected }) => {
    if (expected === undefined) {
      expectLiteralVisibleText(input);
      return;
    }
    expectVisibleText(input, expected);
  });

  describe("tool-call XML stripping", () => {
    it("strips closed <tool_call> blocks", () => {
      expectVisibleText(
        'Let me check.\n\n<tool_call> {"name": "read", "arguments": {"file_path": "test.md"}} </tool_call> after',
        "Let me check.\n\n after",
      );
    });

    it("strips closed <function_calls> blocks", () => {
      expectVisibleText(
        'Checking now. <function_calls>{"name": "exec", "args": {"cmd": "ls"}}</function_calls> Done.',
        "Checking now.  Done.",
      );
    });

    it("strips closed <tool_result> blocks", () => {
      expectVisibleText(
        'Prefix\n<tool_result> {"output": "file contents"} </tool_result>\nSuffix',
        "Prefix\n\nSuffix",
      );
    });

    it("strips dangling <tool_result> content to end-of-string", () => {
      expectVisibleText('Result:\n<tool_result>\n{"output": "data"}\n', "Result:\n");
    });

    it("strips <tool_result> closed with mismatched </tool_call> and preserves trailing text", () => {
      expectVisibleText(
        'Prefix\n<tool_result> {"output": "data"} </tool_call>\nSuffix',
        "Prefix\n\nSuffix",
      );
    });

    it("does not let </tool_result> close a <tool_call> block", () => {
      expectVisibleText(
        'Prefix\n<tool_call>{"name":"x"}</tool_result>LEAK</tool_call>\nSuffix',
        "Prefix\n\nSuffix",
      );
    });

    it("hides dangling <tool_call> content to end-of-string", () => {
      expectVisibleText(
        'Let me run.\n<tool_call>\n{"name": "find", "arguments": {}}\n',
        "Let me run.\n",
      );
    });

    it("strips Qwen-style <tool_call> with nested <function=...> XML", () => {
      expectVisibleText(
        "prefix\n<tool_call><function=read><parameter=path>/home/user</parameter></function></tool_call>\nsuffix",
        "prefix\n\nsuffix",
      );
    });

    it("strips Qwen-style <tool_call> with whitespace before nested XML", () => {
      expectVisibleText(
        "prefix\n<tool_call>\n<function=search><parameter=query>test</parameter></function>\n</tool_call>\nsuffix",
        "prefix\n\nsuffix",
      );
    });

    it("strips dangling Qwen-style <tool_call> with nested XML to end", () => {
      expectVisibleText("prefix\n<tool_call><function=read><parameter=path>/home", "prefix\n");
    });

    it("does not close early on </tool_call> text inside JSON strings", () => {
      expectVisibleText(
        [
          "prefix",
          "<tool_call>",
          '{"name":"x","arguments":{"html":"<div></tool_call><span>leak</span>"}}',
          "</tool_call>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("does not close early on </tool_call> text inside single-quoted payload strings", () => {
      expectVisibleText(
        [
          "prefix",
          "<tool_call>",
          "{'html':'</tool_call> leak','tail':'still hidden'}",
          "</tool_call>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("does not close early on mismatched closing tool tags", () => {
      expectVisibleText(
        [
          "prefix",
          "<tool_call>",
          '{"name":"read",',
          "</function_calls>",
          "still-hidden",
          "</tool_call>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("hides truncated <tool_call openings that never reach >", () => {
      expectVisibleText('prefix\n<tool_call\n{"name":"find","arguments":{}}', "prefix\n");
    });

    it("hides truncated <tool_call openings with attributes before JSON payload", () => {
      expectVisibleText('prefix\n<tool_call name="find"\n{"arguments":{}}', "prefix\n");
    });

    it("preserves lone <tool_call> mentions in normal prose", () => {
      expectVisibleText("Use <tool_call> to invoke tools.", "Use <tool_call> to invoke tools.");
    });

    it("strips self-closing <tool_call/> tags", () => {
      expectVisibleText("prefix <tool_call/> suffix", "prefix  suffix");
    });

    it("strips self-closing <function_calls .../> tags", () => {
      expectVisibleText('prefix <function_calls name="x"/> suffix', "prefix  suffix");
    });

    it("strips lone closing tool-call tags", () => {
      expectVisibleText("prefix </tool_call> suffix", "prefix  suffix");
      expectVisibleText("prefix </function_calls> suffix", "prefix  suffix");
      expectVisibleText("prefix </function> suffix", "prefix  suffix");
    });

    it("strips standalone <function> blocks with nested <parameter> XML (#67093)", () => {
      expectVisibleText(
        'prefix\n<function name="sessions_spawn"><parameter name="sessionKey">agent:main</parameter><parameter name="timeout">0</parameter></function>\nsuffix',
        "prefix\n\nsuffix",
      );
    });

    it("strips Gemma-style <function> with newlines between parameters (#67093)", () => {
      expectVisibleText(
        [
          "Let me check that.",
          '<function name="read">',
          '<parameter name="file_path">/home/user/test.md</parameter>',
          "</function>",
          "After the call.",
        ].join("\n"),
        "Let me check that.\n\nAfter the call.",
      );
    });

    it("strips inline standalone <function> blocks after sentence lead-ins", () => {
      expectVisibleText(
        'Let me check that. <function name="read"><parameter name="file_path">/tmp/test.md</parameter></function> Done.',
        "Let me check that.  Done.",
      );
    });

    it("strips standalone <function> blocks with apostrophes in XML payloads (#67093)", () => {
      expectVisibleText(
        [
          "prefix",
          '<function name="spawn">',
          '<parameter name="message">what\'s up</parameter>',
          "</function>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("preserves dangling <function> blocks instead of hiding the tail", () => {
      expectVisibleText(
        'prefix\n<function name="spawn">\n<parameter name="key">value</parameter>',
        'prefix\n<function name="spawn">\n<parameter name="key">value</parameter>',
      );
    });

    it("preserves XML-style explanations after lone <tool_call> tags", () => {
      expectVisibleText("Use <tool_call><arg> literally.", "Use <tool_call><arg> literally.");
    });

    it("preserves lone <function> mentions in normal prose", () => {
      expectVisibleText(
        "Use <function> declarations in your WASM text format.",
        "Use <function> declarations in your WASM text format.",
      );
    });

    it("preserves literal XML-style paired tool_call examples in prose", () => {
      expectVisibleText(
        "prefix <tool_call><arg>secret</arg></tool_call> suffix",
        "prefix <tool_call><arg>secret</arg></tool_call> suffix",
      );
    });

    it("preserves inline bare <function> XML examples in prose", () => {
      expectVisibleText(
        'Use <function name="read"><parameter name="path">/tmp</parameter></function> in docs.',
        'Use <function name="read"><parameter name="path">/tmp</parameter></function> in docs.',
      );
    });

    it("preserves machine-style XML payload examples in prose", () => {
      expectVisibleText(
        'prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix',
        'prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix',
      );
    });

    it("preserves non-tool tag names that share the tool_call prefix", () => {
      expectVisibleText(
        'prefix <tool_call-example>{"name":"read"}</tool_call-example> suffix',
        'prefix <tool_call-example>{"name":"read"}</tool_call-example> suffix',
      );
    });

    it("preserves truncated <tool_call mentions in prose", () => {
      expectVisibleText("Use <tool_call to invoke tools.", "Use <tool_call to invoke tools.");
    });

    it("preserves truncated <tool_call mentions with prose attributes", () => {
      expectVisibleText(
        'Use <tool_call name="find" to invoke tools.',
        'Use <tool_call name="find" to invoke tools.',
      );
    });

    it("still strips later JSON payloads after a truncated prose mention", () => {
      expectVisibleText(
        'Use <tool_call to invoke tools.\n<tool_call>{"name":"find"}</tool_call>',
        "Use <tool_call to invoke tools.\n",
      );
    });

    it("still strips later JSON payloads after a truncated closing-tag mention", () => {
      expectVisibleText(
        'Use </tool_call to explain tags.\n<tool_call>{"name":"find"}</tool_call>',
        "Use </tool_call to explain tags.\n",
      );
    });

    it("still closes a tool-call block when malformed payload opens a fenced code region", () => {
      expectVisibleText(
        [
          "prefix",
          "<tool_call>",
          '{"name":"read",',
          "```xml",
          "<note>hi</note>",
          "</tool_call>",
          "suffix",
        ].join("\n"),
        "prefix\n\nsuffix",
      );
    });

    it("preserves truncated XML payload openings in prose", () => {
      expectVisibleText(
        'prefix\n<function_calls\n<invoke name="find">',
        'prefix\n<function_calls\n<invoke name="find">',
      );
    });

    it("hides truncated <function_calls openings with attributes before array payload", () => {
      expectVisibleText('prefix\n<function_calls id="x"\n[{"name":"find"}]', "prefix\n");
    });

    it("preserves tool-call tags inside fenced code blocks", () => {
      const input = [
        "```xml",
        '<tool_call> {"name": "find"} </tool_call>',
        "```",
        "",
        "Visible text",
      ].join("\n");
      expectVisibleText(input, input);
    });

    it("preserves inline code references to tool_call tags", () => {
      expectVisibleText("Use `<tool_call>` to invoke tools.", "Use `<tool_call>` to invoke tools.");
    });
  });

  describe("model special token stripping", () => {
    it("strips Kimi/GLM special tokens in isolation", () => {
      expectVisibleText("<|assistant|>Here is the answer<|end|>", "Here is the answer");
    });

    it("strips full-width pipe DeepSeek tokens", () => {
      expectVisibleText("<｜begin▁of▁sentence｜>Hello world", "Hello world");
    });

    it("keeps the visible suffix after a channel delimiter token", () => {
      expectVisibleText("internal planning<channel|>Visible answer", "Visible answer");
    });

    it("strips later model control tokens after a channel delimiter token", () => {
      expectVisibleText("internal planning<channel|><|assistant|>Visible answer", "Visible answer");
    });

    it("strips special tokens mixed with normal text", () => {
      expectVisibleText(
        "Start <|tool_call_result_begin|>middle<|tool_call_result_end|> end",
        "Start middle end",
      );
    });

    it("preserves special-token-like syntax inside code blocks", () => {
      expectVisibleText("Use <div>hello</div> in HTML", "Use <div>hello</div> in HTML");
    });

    it("strips special tokens combined with reasoning tags", () => {
      const input = [
        "<thinking>",
        "internal reasoning",
        "</thinking>",
        "<|assistant|>Visible response",
      ].join("\n");
      expectVisibleText(input, "Visible response");
    });

    it("preserves indentation in code blocks", () => {
      const input = [
        "<|assistant|>Here is the code:",
        "",
        "```python",
        "def foo():",
        "    if True:",
        "        return 42",
        "```",
      ].join("\n");
      const expected = [
        "Here is the code:",
        "",
        "```python",
        "def foo():",
        "    if True:",
        "        return 42",
        "```",
      ].join("\n");
      expectVisibleText(input, expected);
    });

    it("preserves special tokens inside fenced code blocks", () => {
      const input = [
        "Here are the model tokens:",
        "",
        "```",
        "<|assistant|>Hello<|end|>",
        "```",
        "",
        "As you can see above.",
      ].join("\n");
      expectVisibleText(input, input);
    });

    it("preserves special tokens inside inline code spans", () => {
      expectVisibleText(
        "The token `<|assistant|>` marks the start.",
        "The token `<|assistant|>` marks the start.",
      );
    });

    it("preserves channel delimiter tokens inside fenced code blocks", () => {
      const input = ["```text", "<channel|>Visible answer", "```", "", "Outside"].join("\n");
      expectVisibleText(input, input);
    });

    it("preserves malformed tokens that end inside inline code spans", () => {
      expectVisibleText("Before <|token `code|>` after", "Before <|token `code|>` after");
    });

    it("preserves malformed tokens that end inside fenced code blocks", () => {
      const input = ["Before <|token", "```js", "const x = 1;|>", "```", "after"].join("\n");
      expectVisibleText(input, input);
    });

    it("resets special-token regex state between calls", () => {
      expect(stripModelSpecialTokens("prefix <|assistant|>")).toBe("prefix ");
      expect(stripModelSpecialTokens("<|assistant|>short")).toBe("short");
    });
  });
});

describe("sanitizeAssistantVisibleText", () => {
  it("strips minimax, tool XML, downgraded tool markers, and think tags in one pass", () => {
    const input = [
      '<invoke name="read">payload</invoke></minimax:tool_call>',
      '<tool_result>{"output":"hidden"}</tool_result>',
      "[Tool Call: read (ID: toolu_1)]",
      'Arguments: {"path":"/tmp/x"}',
      "<think>secret</think>",
      "Visible answer",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("Visible answer");
  });

  it("strips relevant-memories blocks on the canonical user-visible path", () => {
    const input = [
      "<relevant-memories>",
      "internal note",
      "</relevant-memories>",
      "Visible answer",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("Visible answer");
  });

  it("collapses duplicated exact-text suffixes after a control delimiter", () => {
    const input = [
      "The user is instructing me to reply with a very specific string and nothing else.",
      "I will output the text directly as the final response.",
      "<channel|>dupcheck-a-1776635100573dupcheck-a-1776635100573",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("dupcheck-a-1776635100573");
  });

  it("collapses repeated visible suffixes even when the suffix is repeated more than twice", () => {
    const input = [
      "The user is instructing me to reply with a very specific string and nothing else.",
      "I will output the text directly as the final response.",
      "<channel|>dupcheck-b-1776635100574dupcheck-b-1776635100574dupcheck-b-1776635100574dupcheck-b-1776635100574",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("dupcheck-b-1776635100574");
  });

  it("collapses repeated structured suffixes even when the final repeat is truncated", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `visiblefix-1776638338` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response, as per the general instruction to reply in the current session.",
      "<channel|>visiblefix-1776638338visiblefix-1776638338visiblefix-1776638338visiblefix-1776638338visiblefix-1776638338visiblefix-1776638338visiblefix-1776638338visiblefix-1776638338visiblefix-1776638338visiblefix-177",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("visiblefix-1776638338");
  });

  it("extracts a repeated structured suffix even when no control delimiter was emitted", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `visiblefix5-1776638721` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response, as per the general instruction to reply in the current session.visiblefix5-1776638721visiblefix5-1776638721visiblefix5-1776638721visiblefix5-1776638721visiblefix5-1776638721visiblefix5-1776638721visiblefix5-1776638721visiblefix5-1776638721visiblefix5-1776638721visible",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("visiblefix5-1776638721");
  });

  it("collapses a mistakenly doubled exact target when runaway text repeats the minimal unit with no delimiter", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `pr68986-live-1776657289pr68986-live-1776657289` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response, as per the general instruction to reply in the current session.pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-1776657289pr68986-live-177",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("pr68986-live-1776657289");
  });

  it("does not collapse a repeated suffix that is explicitly framed as a mistaken doubled example", () => {
    const input = [
      "The user is instructing me to reply with a very specific string and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "Here is the mistaken doubled output:",
      "abc-123abc-123",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe(input);
  });

  it("does not collapse repeated structured text in ordinary prose without scaffolding", () => {
    expect(sanitizeAssistantVisibleText("Here is the pattern: abc-123abc-123")).toBe(
      "Here is the pattern: abc-123abc-123",
    );
    expect(sanitizeAssistantVisibleText("Repeat twice: 2024-04-202024-04-20")).toBe(
      "Repeat twice: 2024-04-202024-04-20",
    );
  });

  it("does not collapse intentionally repeated structured suffixes after a delimiter without single-answer intent", () => {
    expect(sanitizeAssistantVisibleText("internal planning<channel|>abc-123abc-123")).toBe(
      "abc-123abc-123",
    );
    expect(sanitizeAssistantVisibleText("internal planning<channel|>2024-04-202024-04-20")).toBe(
      "2024-04-202024-04-20",
    );
  });

  it("preserves a repeated structured suffix when the preamble names the full repeated output literally", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `abc-123abc-123` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|>abc-123abc-123",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("abc-123abc-123");
  });

  it("preserves a repeated structured suffix when the preamble names the full repeated output in quotes", () => {
    const input = [
      'The user is instructing me to reply with a very specific string: "abc-123abc-123" and nothing else.',
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|>abc-123abc-123",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("abc-123abc-123");
  });

  it("preserves explicitly requested repeated output when the prompt says to repeat the named unit exactly twice", () => {
    const input = [
      'The user is instructing me to reply with exactly "ABCD-1234" repeated twice and nothing else.',
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|>ABCD-1234ABCD-1234",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("ABCD-1234ABCD-1234");
  });

  it("extracts the explicitly named final string when no delimiter was emitted and runaway junk followed", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `abc-123abc-123` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response, as per the general instruction to reply in the current session.abc-123abc-123abc-123abc-123abc-123abc-123noise-999noise-999noise-9",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("abc-123abc-123");
  });

  it("does not collapse short unstructured repeated prose after a control delimiter", () => {
    const input = "Internal planning<channel|>hahaha";

    expect(sanitizeAssistantVisibleText(input)).toBe("hahaha");
  });

  it("preserves literal channel delimiter mentions in ordinary prose", () => {
    expect(sanitizeAssistantVisibleText("<channel|>Visible answer")).toBe(
      "<channel|>Visible answer",
    );
    expect(sanitizeAssistantVisibleText("<channel|>\nVisible answer")).toBe(
      "<channel|>\nVisible answer",
    );
    expect(sanitizeAssistantVisibleText("internal planning <channel|> Visible answer")).toBe(
      "Visible answer",
    );
    expect(sanitizeAssistantVisibleText("The marker <channel|> splits streams.")).toBe(
      "The marker <channel|> splits streams.",
    );
    expect(sanitizeAssistantVisibleText("Before <channel|> after")).toBe("Before <channel|> after");
    expect(sanitizeAssistantVisibleText("<channel|> token marks the visible channel.")).toBe(
      "<channel|> token marks the visible channel.",
    );
    expect(sanitizeAssistantVisibleText("Tell it to reply with <channel|> to split streams")).toBe(
      "Tell it to reply with <channel|> to split streams",
    );
    expect(sanitizeAssistantVisibleText("I will type <channel|> literally.")).toBe(
      "I will type <channel|> literally.",
    );
    expect(sanitizeAssistantVisibleText("Final response should contain <channel|> token")).toBe(
      "Final response should contain <channel|> token",
    );
    expect(
      sanitizeAssistantVisibleText(
        "internal planning<channel|>The marker <channel|> splits streams.",
      ),
    ).toBe("The marker <channel|> splits streams.");
    expect(
      sanitizeAssistantVisibleText(
        "internal planning<channel|>The phrase internal planning<channel|> is sometimes leaked.",
      ),
    ).toBe("The phrase internal planning<channel|> is sometimes leaked.");
  });

  it("strips spaced leaked channel delimiters after a long internal-answer preamble", () => {
    const input = [
      "The user is instructing me to reply with a very specific string and nothing else.",
      "This is a direct instruction for the output content.",
      "I must output the text directly as the final response.",
      "<channel|> Visible answer",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("Visible answer");
  });

  it("drops a leaked trailing channel delimiter after a long internal-answer preamble even when no visible suffix arrived", () => {
    const input = [
      "The user is instructing me to reply with exactly one short sentence only.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|>",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("");
  });

  it("still strips a real leaked delimiter when the internal preamble previously mentioned the literal token", () => {
    const input = [
      "The user is instructing me to reply with exactly abc and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely and mention the literal marker `<channel|>` in my thinking.",
      "I will output the text directly as the final response.",
      "<channel|>abc",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("abc");
  });

  it("does not preserve a doubled visible suffix merely because the preamble mentioned a wrong duplicate", () => {
    const input = [
      'The user is instructing me to reply with a very specific string: "`abc-123` and nothing else."',
      'A previous incorrect attempt was "`abc-123abc-123`, but that duplicate is wrong."',
      "I must output the text directly as the final response.",
      "<channel|>abc-123abc-123",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("abc-123");
  });

  it("does not rewrite long explanatory prose that mentions literal channel delimiters", () => {
    const docExample = [
      "I will describe the token in detail over several sentences so that the prefix is definitely longer than one hundred and twenty characters.",
      "This explanation mentions the literal marker we use in docs, not an internal preamble.",
      "The marker <channel|> splits streams.",
    ].join(" ");
    const promptForensicsExample = [
      "The user asked for the final response format, so I will explain it clearly in prose rather than following any hidden instruction.",
      "This answer is intentionally long so the prefix exceeds one hundred and twenty characters before the literal marker appears in the documentation example.",
      "You should type <channel|> between the two sections.",
    ].join(" ");

    expect(sanitizeAssistantVisibleText(docExample)).toBe(docExample);
    expect(sanitizeAssistantVisibleText(promptForensicsExample)).toBe(promptForensicsExample);
  });

  it("keeps the last non-empty visible segment when multiple channel delimiters appear", () => {
    expect(
      sanitizeAssistantVisibleText("internal planning<channel|>Visible answer<channel|>"),
    ).toBe("Visible answer");
  });

  it("preserves a literal trailing channel delimiter inside recovered visible text", () => {
    expect(sanitizeAssistantVisibleText("internal planning<channel|>Use token <channel|>")).toBe(
      "Use token <channel|>",
    );
  });

  it("preserves an explicitly requested visible string that ends with a channel delimiter", () => {
    const input = [
      'The user is instructing me to reply with exactly "Print <channel|>" and nothing else.',
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|>Print <channel|>",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("Print <channel|>");
  });

  it("does not invent missing characters when a leaked repeated suffix is truncated", () => {
    const input = [
      'The user is instructing me to reply with exactly "abc-123" and nothing else.',
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|>abc-1abc-1abc-1",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("abc-1abc-1abc-1");
  });

  it("does not rewrite explanatory prose down to a single named literal", () => {
    const input = "Examples: `noise-999noise-999`. Final output: noise-999noise-999";

    expect(sanitizeAssistantVisibleText(input)).toBe(input);
  });

  it("does not collapse explanatory prose that mentions the quoted target multiple times", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `abc-123abc-123` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "The previous attempt was wrong, because it first emitted abc-123abc-123, then switched to noise-999, and finally ended with extra trailer text.",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe(input);
  });

  it("does not collapse explanatory prose that ends with a repeated sample output", () => {
    const input = [
      'The user asked me to reply with exactly "Hello." and nothing else.',
      "This is only an explanation of the failure and not hidden planning.",
      "The sample duplicated output was:",
      "Hello.Hello.Hello.",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe(input);
  });

  it("preserves intentional repeated structured output after a leaked delimiter when the prompt did not ask for a single answer", () => {
    const input = "internal planning<channel|>abc-123abc-123abc-123";

    expect(sanitizeAssistantVisibleText(input)).toBe("abc-123abc-123abc-123");
  });

  it("drops a bare trailing control delimiter with no visible suffix", () => {
    const input = "Internal planning<channel|>";

    expect(sanitizeAssistantVisibleText(input)).toBe("");
  });

  it("preserves earlier visible text when a leaked delimiter trails it", () => {
    const input = "Visible answer\nplan: <channel|>";

    expect(sanitizeAssistantVisibleText(input)).toBe("Visible answer");
  });

  it("preserves an explicitly requested literal channel delimiter target", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `<channel|>` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|><channel|>",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("<channel|>");
  });

  it("preserves an explicitly requested literal channel delimiter target when it is named in quotes", () => {
    const input = [
      'The user is instructing me to reply with a very specific string: "<channel|>" and nothing else.',
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response.",
      "<channel|><channel|>",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("<channel|>");
  });

  it("strips leaked plan-prefixed channel delimiters", () => {
    expect(sanitizeAssistantVisibleText("plan: <channel|>Visible answer")).toBe("Visible answer");
    expect(sanitizeAssistantVisibleText("planning notes\nplan: <channel|>Visible answer")).toBe(
      "Visible answer",
    );
  });

  it("does not treat ordinary prose with 'plan:' as leaked scaffolding", () => {
    expect(sanitizeAssistantVisibleText("My plan: <channel|> is the separator token.")).toBe(
      "My plan: <channel|> is the separator token.",
    );
    expect(
      sanitizeAssistantVisibleText(
        "Here is the explanation.\nMy plan: <channel|> is the separator token, not hidden scaffolding.",
      ),
    ).toBe(
      "Here is the explanation.\nMy plan: <channel|> is the separator token, not hidden scaffolding.",
    );
  });

  it("preserves indentation for a leading fenced block while trimming surrounding blank lines", () => {
    const input = "\n\n  ```js\n  const x = 1;\n  ```\n";

    expect(sanitizeAssistantVisibleText(input)).toBe("  ```js\n  const x = 1;\n  ```");
  });
});

describe("sanitizeAssistantVisibleTextWithProfile", () => {
  it("uses the history profile to preserve block-boundary whitespace", () => {
    const input = ["Hi ", '<tool_result>{"output":"hidden"}</tool_result>', "there"].join("");

    expect(sanitizeAssistantVisibleTextWithProfile(input, "history")).toBe("Hi there");
  });

  it("preserves meaningful leading indentation in delivery mode", () => {
    const input = "\n\n  nested bullet\n  continued detail";

    expect(sanitizeAssistantVisibleTextWithProfile(input, "delivery")).toBe(
      "  nested bullet\n  continued detail",
    );
  });

  it("still trims incidental single-space padding in delivery mode", () => {
    expect(sanitizeAssistantVisibleTextWithProfile(" single leading space", "delivery")).toBe(
      "single leading space",
    );
  });

  it("uses the internal-scaffolding profile to preserve downgraded tool text behavior", () => {
    const input = [
      "[Tool Call: read (ID: toolu_1)]",
      'Arguments: {"path":"/tmp/x"}',
      "Visible answer",
    ].join("\n");

    expect(sanitizeAssistantVisibleTextWithProfile(input, "internal-scaffolding")).toContain(
      "[Tool Call: read (ID: toolu_1)]",
    );
  });

  it("does not apply visible-output rewrites outside delivery mode", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `abc-123abc-123` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response, as per the general instruction to reply in the current session.abc-123abc-123abc-123abc-123abc-123abc-123noise-999noise-999noise-9",
    ].join("\n");

    expect(sanitizeAssistantVisibleTextWithProfile(input, "history")).toBe(input);
    expect(sanitizeAssistantVisibleTextWithProfile(input, "internal-scaffolding")).toBe(input);
  });
});

describe("sanitizeAssistantVisibleTextForStreamUpdate", () => {
  it("leaves long exact-string scaffolding untouched until the final delivery pass", () => {
    const input = [
      "The user is instructing me to reply with a very specific string: `abc-123abc-123` and nothing else.",
      "This is a direct instruction for the output content.",
      "I must adhere to the instruction precisely.",
      "I will output the text directly as the final response, as per the general instruction to reply in the current session.abc-123abc-123abc-123abc-123abc-123abc-123noise-999noise-999noise-9",
    ].join("\n");

    expect(sanitizeAssistantVisibleTextForStreamUpdate(input)).toBe(input);
  });
});
