import { describe, expect, it } from "vitest";
import {
  minimaxToolCallTextFilter,
  sanitizeAssistantFinalAnswerText,
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripAssistantInternalScaffolding,
  stripToolCallXmlTags,
} from "./assistant-visible-text.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";

describe("stripAssistantInternalScaffolding", () => {
  function expectVisibleText(input: string, expected = input) {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  }

  it.each([
    [
      "hides unfinished relevant-memories blocks",
      "Hello\n<relevant-memories>\ninternal-only",
      "Hello\n",
    ],
    [
      "removes leading blank lines after stripping scaffolding",
      "<thinking>\nsecret\n</thinking>\n   \n<relevant-memories>\ninternal note\n</relevant-memories>\n  Visible",
      "  Visible",
    ],
    [
      "preserves unfinished reasoning text while still stripping memory blocks",
      "Before\n<thinking>\nsecret\n<relevant-memories>\ninternal note\n</relevant-memories>\nAfter",
      "Before\n\nsecret\n\nAfter",
    ],
    [
      "keeps relevant-memories tags inside fenced code",
      "```xml\n<relevant-memories>\nsample\n</relevant-memories>\n```\n\nVisible text",
      undefined,
    ],
    [
      "strips <tool_result> closed with mismatched </tool_call> and preserves trailing text",
      'Prefix\n<tool_result> {"output": "data"} </tool_call>\nSuffix',
      "Prefix\n\nSuffix",
    ],
    [
      "does not let </tool_result> close a <tool_call> block",
      'Prefix\n<tool_call>{"name":"x"}</tool_result>LEAK</tool_call>\nSuffix',
      "Prefix\n\nSuffix",
    ],
    [
      "hides dangling legacy uppercase TOOL_CALL blocks to end-of-string",
      'Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"NET stock price"}',
      "Before\n",
    ],
    [
      "strips Qwen-style <tool_call> with nested <function=...> XML",
      "prefix\n<tool_call><function=read><parameter=path>/home/user</parameter></function></tool_call>\nsuffix",
      "prefix\n\nsuffix",
    ],
    [
      "hides truncated <tool_call openings with attributes before JSON payload",
      'prefix\n<tool_call name="find"\n{"arguments":{}}',
      "prefix\n",
    ],
    [
      "strips self-closing <function_calls .../> tags",
      'prefix <function_calls name="x"/> suffix',
      "prefix  suffix",
    ],
    [
      "strips inline standalone <function> blocks after sentence lead-ins",
      'Let me check that. <function name="read"><parameter name="file_path">/tmp/test.md</parameter></function> Done.',
      "Let me check that.  Done.",
    ],
    [
      "preserves dangling <function> blocks instead of hiding the tail",
      'prefix\n<function name="spawn">\n<parameter name="key">value</parameter>',
      'prefix\n<function name="spawn">\n<parameter name="key">value</parameter>',
    ],
    [
      "keeps truncated tool-call parameters fail-closed",
      '<tool_call><parameter name="token">secret</parameter>',
      "",
    ],
    [
      "preserves literal XML-style paired tool_call examples in prose",
      "prefix <tool_call><arg>secret</arg></tool_call> suffix",
      "prefix <tool_call><arg>secret</arg></tool_call> suffix",
    ],
    [
      "preserves inline closed function_response examples in prose",
      "Use <function_response>ok</function_response> to describe the response wrapper.",
      "Use <function_response>ok</function_response> to describe the response wrapper.",
    ],
    [
      "preserves line-leading function_response prose examples",
      "<function_response> is the response wrapper.",
      "<function_response> is the response wrapper.",
    ],
    [
      "still strips later JSON payloads after a truncated prose mention",
      'Use <tool_call to invoke tools.\n<tool_call>{"name":"find"}</tool_call>',
      "Use <tool_call to invoke tools.\n",
    ],
    [
      "still strips later JSON payloads after a truncated closing-tag mention",
      'Use </tool_call to explain tags.\n<tool_call>{"name":"find"}</tool_call>',
      "Use </tool_call to explain tags.\n",
    ],
    [
      "hides truncated <function_calls openings with attributes before array payload",
      'prefix\n<function_calls id="x"\n[{"name":"find"}]',
      "prefix\n",
    ],
    [
      "does not close early on single-quoted payload strings",
      "prefix\n<tool_call>\n{'html':'</tool_call> leak','tail':'still hidden'}\n</tool_call>\nsuffix",
      "prefix\n\nsuffix",
    ],
    [
      "preserves escaped quote state across apparent closing tags",
      "prefix\n<tool_call>\n" +
        JSON.stringify({ html: '"</tool_call>', tail: "</tool_call> still hidden" }) +
        "\n</tool_call>\nsuffix",
      "prefix\n\nsuffix",
    ],
    [
      "strips standalone function XML containing apostrophes",
      'prefix\n<function name="spawn">\n<parameter name="message">what\'s up</parameter>\n</function>\nsuffix',
      "prefix\n\nsuffix",
    ],
    ["strips lone closing tags", "prefix </tool_call> suffix", "prefix  suffix"],
  ] as const)("%s", (_name, input, expected) => {
    expectVisibleText(input, expected ?? input);
  });

  it("strips workflow <function_response> blocks with plain output", () => {
    expectVisibleText(
      'Before\n<function_response>\nSearching for: "what skills matter most in the age of AI"\n...\n</function_response>\nAfter',
      "Before\n\nAfter",
    );
  });

  it("strips legacy uppercase TOOL_RESULT blocks with object payloads", () => {
    expectVisibleText(
      'Before\n[TOOL_RESULT]{"output":"secret result"}[/TOOL_RESULT]\nAfter',
      "Before\n\nAfter",
    );
  });

  it("preserves legacy uppercase TOOL_CALL blocks inside fenced code", () => {
    const input =
      '```text\n[TOOL_CALL]{tool => "web_search", args => {"query":"x"}}[/TOOL_CALL]\n```\nVisible';
    expectVisibleText(input, input);
  });

  it("unwraps standalone parameter tags while preserving their content (#98557)", () => {
    expectVisibleText(
      'Results: <parameter name="assumptions">some content</parameter> after.',
      "Results: some content after.",
    );
    expectVisibleText(
      '<parameter name="assumptions">\nline 1\nline 2\n</parameter>',
      "line 1\nline 2",
    );
    expectVisibleText('<parameter name="data">{"key":"value"}</parameter>', '{"key":"value"}');
    expectVisibleText('<parameter name="items">[1,2]</parameter>', "[1,2]");
    expectVisibleText(
      'Results:<parameter name="x">\nline\n</parameter>after',
      "Results:\nline\nafter",
    );
  });

  it("preserves parameter tags in code and literal function examples", () => {
    expectVisibleText('Use `<parameter name="path">/tmp</parameter>`.');
    expectVisibleText(
      'Use <function name="read"><parameter name="path">/tmp</parameter></function> in docs.',
    );
    expectVisibleText('<schema><parameter name="path">/tmp</parameter></schema>');
    expectVisibleText('<schema><parameter name="path"/></schema>');
    expectVisibleText('<br><parameter name="path">/tmp</parameter>', "<br>/tmp");
    expectVisibleText(
      'Use <function> declarations. <parameter name="path">/tmp</parameter>',
      "Use <function> declarations. /tmp",
    );
    expectVisibleText(
      '<schema><other data="</schema>"><parameter name="path">/tmp</parameter>',
      '<schema><other data="</schema>">/tmp',
    );
    expectVisibleText(
      '`<schema data="` <parameter>x</parameter> "></schema>',
      '`<schema data="` x "></schema>',
    );
    expectVisibleText("<schema>`</schema>`<parameter>x</parameter>", "<schema>`</schema>`x");
  });

  it("still closes a tool-call block when malformed payload opens a fenced code region", () => {
    expectVisibleText(
      'prefix\n<tool_call>\n{"name":"read",\n```xml\n<note>hi</note>\n</tool_call>\nsuffix',
      "prefix\n\nsuffix",
    );
  });

  it("preserves malformed tokens that end inside inline code spans", () => {
    expectVisibleText("Before <|token `code|>` after", "Before <|token `code|>` after");
  });

  it("resets special-token regex state between calls", () => {
    expect(stripModelSpecialTokens("prefix <|assistant|>")).toBe("prefix ");
    expect(stripModelSpecialTokens("<|assistant|>short")).toBe("short");
  });
});

describe("stripToolCallXmlTags", () => {
  it("strips compact function_response after a newline-separated stripped function_calls block", () => {
    const input =
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls>\n<function_response>ok</function_response>\nAfter';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "Checking. \n\nAfter",
    );
  });

  it("strips plural function/tool wrapper XML only when the opt-in flag is enabled", () => {
    const input =
      'prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix';
    expect(stripToolCallXmlTags(input)).toBe(input);
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "prefix  suffix",
    );
  });

  it("strips antml:invoke with function_call payload", () => {
    const input =
      'prefix <antml:invoke name="exec"><function_call>test</function_call></antml:invoke> suffix';
    expect(stripToolCallXmlTags(input)).toBe("prefix  suffix");
  });

  it.each([
    [
      "dangling adjacent response",
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls><function_response>raw output',
      "Checking. ",
    ],
    [
      "chained adjacent responses",
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls><function_response>first</function_response><function_response>second</function_response>\nAfter',
      "Checking. \nAfter",
    ],
  ])("strips %s", (_name, input, expected) => {
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(expected);
  });
});

describe("MiniMax tool-call text", () => {
  it("preserves minimax tool-call XML examples inside inline and fenced code", () => {
    const inline = 'Use `<minimax:tool_call><invoke name="exec">x</invoke></minimax:tool_call>`.';
    const fenced =
      '```xml\n<minimax:tool_call><invoke name="exec">x</invoke></minimax:tool_call>\n```';

    expect(minimaxToolCallTextFilter.transform(inline)).toBe(inline);
    expect(minimaxToolCallTextFilter.transform(fenced)).toBe(fenced);
  });
});

describe("sanitizeAssistantVisibleText", () => {
  it("preserves prose examples of plural function-call XML on the delivery path", () => {
    const input =
      'prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix';

    expect(sanitizeAssistantVisibleText(input)).toBe(input);
  });

  it.each([
    ["Tool Result", "[Tool Result for ID abc]\nstdout: hello"],
    ["Tool Call and Arguments", '[Tool Call: bash (ID: 7)]\nArguments: {"cmd":"ls"}'],
  ])("preserves fenced %s logs", (_name, log) => {
    const input = "Log format explainer:\n\n```text\n" + log + "\n```\n\nThen we continue.";
    expect(sanitizeAssistantVisibleText(input)).toBe(input);
  });

  it.each([
    ["Tool Result", "[Tool Result for ID abc]\nstdout: hello", ""],
    ["Historical context", "[Historical context: earlier run]\nVisible answer", "Visible answer"],
  ])("strips downgraded %s markers", (_name, input, expected) => {
    expect(sanitizeAssistantVisibleText(input)).toBe(expected);
  });

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

  it("strips adjacent plural function-call XML on the delivery path", () => {
    const input =
      '<function_calls><invoke name="exec">internal</invoke></function_calls><function_response>\nSearching for: "what skills matter most in the age of AI"\n</function_response>\nVisible answer';
    expect(sanitizeAssistantVisibleText(input)).toBe("Visible answer");
  });

  it("strips internal tool trace warning lines on the delivery path", () => {
    const input = [
      "Visible intro.",
      "⚠️ 🛠️ `run openclaw definitely-not-a-real-subcommand (agent)` failed",
      "⚠️ 🛠️ gh search issues --repo openclaw/openclaw --state open --no-search-pages.jsonl /tmp/openclaw_open_unlabeled_current.json (agent) failed",
      "⚠️ 🛠️ gh search issues --repo openclaw/openclaw --state open (agent) failed: command timed out",
      "⚠️ 🛠️ Exec failed: `python3 /path/to/daily-cost-audit.py` (exit 1)",
      "⚠️ 🛠️ Bash failed: `git status` (workspace) (exit 1)",
      "⚠️ 🛠️ Exec failed (exit 1)",
      "⚠️ 🛠️ Bash failed",
      "🛠️ run git status",
      "Visible outro.",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("Visible intro.\nVisible outro.");
  });

  it("preserves internal tool trace examples inside fenced code", () => {
    const input = [
      "Example:",
      "```",
      "⚠️ 🛠️ Exec failed: `python3 /path/to/daily-cost-audit.py` (exit 1)",
      "⚠️ 🛠️ `run openclaw definitely-not-a-real-subcommand (agent)` failed",
      "```",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe(input);
  });

  it("recovers fully wrapped unclosed reasoning tags that would otherwise deliver empty text", () => {
    expect(sanitizeAssistantVisibleText("<think>Visible answer from a malformed local model")).toBe(
      "Visible answer from a malformed local model",
    );
  });

  it("hides mid-answer unclosed reasoning tags on the raw delivery path", () => {
    expect(sanitizeAssistantVisibleText("Visible prefix <think>private reasoning tail")).toBe(
      "Visible prefix",
    );
  });

  it("keeps unclosed literal reasoning-looking tags in final-answer prose", () => {
    expect(
      sanitizeAssistantFinalAnswerText("<think>hidden</think>Use <think> literally here"),
    ).toBe("Use <think> literally here");
    expect(sanitizeAssistantFinalAnswerText("Before <think>literal tag text after")).toBe(
      "Before <think>literal tag text after",
    );
  });

  it("never recovers unclosed internal reflection from final-answer prose", () => {
    expect(
      sanitizeAssistantFinalAnswerText("Visible prefix <thinking><internal>private reflection"),
    ).toBe("Visible prefix");
  });
});

describe("sanitizeAssistantVisibleTextWithProfile", () => {
  it("preserves text boundaries around model tokens", () => {
    const input = "(**bold<|assistant|>**). First<|user|><|assistant|>second `x<|assistant|>y`";
    expect(sanitizeAssistantVisibleTextWithProfile(input, "delivery")).toBe(
      "(**bold**). First second `x<|assistant|>y`",
    );
  });

  it("uses the history profile to drop malformed reasoning before orphan close tags", () => {
    expect(
      sanitizeAssistantVisibleTextWithProfile(
        "private chain of thought </think> Visible answer",
        "history",
      ),
    ).toBe(" Visible answer");
  });

  it("uses the internal-scaffolding profile to preserve downgraded tool text behavior", () => {
    const input = '[Tool Call: read (ID: toolu_1)]\nArguments: {"path":"/tmp/x"}\nVisible answer';

    expect(sanitizeAssistantVisibleTextWithProfile(input, "internal-scaffolding")).toBe(input);
  });

  it("uses the tool-progress profile to strip scaffolding while preserving progress lines", () => {
    const input =
      '<think>private reasoning</think>\n<tool_call>{"name":"x"}</tool_call>\n🛠️ run git status';

    expect(sanitizeAssistantVisibleTextWithProfile(input, "tool-progress")).toBe(
      "🛠️ run git status",
    );
  });
});

it("preserves indentation after removing leading assistant scaffolding", () => {
  expect(stripAssistantInternalScaffolding("<thinking>hidden</thinking>\n\n    *literal*")).toBe(
    "    *literal*",
  );
  expect(stripAssistantInternalScaffolding("    *literal*")).toBe("    *literal*");
});
