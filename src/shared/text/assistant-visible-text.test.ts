import { describe, expect, it, vi } from "vitest";
import {
  assistantTraceTextFilter,
  assistantVisibleTextFilters,
  minimaxToolCallTextFilter,
  plainToolCallTextFilter,
  sanitizeAssistantFinalAnswerText,
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripAssistantInternalScaffolding,
  stripToolCallXmlTags,
} from "./assistant-visible-text.js";
import { createTextProjection } from "./text-projection.js";

it("keeps an invisible stream pending until visible text arrives and honors replacements", () => {
  const stream = createTextProjection(assistantVisibleTextFilters("delivery"));
  expect(stream.append("\u200b")).toEqual({ text: "", delta: "" });
  expect(stream.append("👩‍💻")).toEqual({ text: "\u200b👩‍💻", delta: "\u200b👩‍💻" });
  expect(stream.replace("\u2060")).toEqual({ text: "", delta: null });
});

it.each([1, 7, 32])(
  "preserves Markdown and strips bracket payloads in %i-character chunks",
  (size) => {
    const literal = '[read]\n{"path":"example.txt"}\n[/read]';
    const visible = `[guide](https://example.test)\n\n\`\`\`text\n${literal}\n\`\`\`\n\nAfter`;
    const raw = `${visible}\n[tool:read]{"path":"hidden.txt"}\nDone`;
    const stream = createTextProjection(assistantVisibleTextFilters("delivery", true));
    for (let offset = 0; offset < raw.length; offset += size) {
      const prefix = raw.slice(0, offset + size);
      expect(stream.append(raw.slice(offset, offset + size)).text).toBe(
        sanitizeAssistantVisibleTextWithProfile(prefix, "delivery", true),
      );
    }
    expect(stream.text).toBe(`${visible}\nDone`);
  },
);

it.each([
  " \t\n",
  "\u0085",
  "\u200b",
  " \u200c\u200d\u2060\ufeff ",
  "\u200e\u2066\u2069",
  "\ufe0f",
])("does not present invisible-only assistant output %j as an answer", (text) => {
  expect(sanitizeAssistantVisibleText(text)).toBe("");
  expect(sanitizeAssistantFinalAnswerText(text)).toBe("");
});

it.each(["word\u200bbreak", "👩‍💻", "می‌روم"])(
  "preserves Unicode formatting within visible answers %j",
  (text) => expect(sanitizeAssistantVisibleText(text)).toBe(text),
);

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
      "preserves inline closed function_response examples in prose",
      "Use <function_response>ok</function_response> to describe the response wrapper.",
      "Use <function_response>ok</function_response> to describe the response wrapper.",
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
      "preserves escaped quote state across apparent closing tags",
      "prefix\n<tool_call>\n" +
        JSON.stringify({ html: '"</tool_call>', tail: "</tool_call> still hidden" }) +
        "\n</tool_call>\nsuffix",
      "prefix\n\nsuffix",
    ],
    ["strips lone closing tags", "prefix </tool_call> suffix", "prefix  suffix"],
  ] as const)("%s", (_name, input, expected) => {
    expectVisibleText(input, expected ?? input);
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
});

describe("stripToolCallXmlTags", () => {
  it("strips compact function_response after a newline-separated stripped function_calls block", () => {
    const input =
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls>\n<function_response>ok</function_response>\nAfter';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "Checking. \n\nAfter",
    );
  });

  it("strips antml:invoke with function_call payload", () => {
    const input =
      'prefix <antml:invoke name="exec"><function_call>test</function_call></antml:invoke> suffix';
    expect(stripToolCallXmlTags(input)).toBe("prefix  suffix");
  });

  it("preserves malformed parameter markup without leaking quote state", () => {
    const text = "<parameter note=unquoted <span>visible</span></parameter>";
    expect(stripToolCallXmlTags(text)).toBe(text);
    expect(stripToolCallXmlTags('<parameter note="<>">next</parameter>')).toBe("next");
  });

  it("handles self-closing and successive tags with UTF-16 text around them", () => {
    const text =
      '\ud800🦊<parameter note="<>"/>one<parameter note=\'><\'>two</parameter><tool_call note=">"/>🦊\udfff';
    expect(stripToolCallXmlTags(text)).toBe("\ud800🦊onetwo🦊\udfff");
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

  it("strips downgraded Tool Result markers", () => {
    expect(sanitizeAssistantVisibleText("[Tool Result for ID abc]\nstdout: hello")).toBe("");
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

  it("keeps literal reasoning-looking tags in final-answer prose while hiding internal reflection", () => {
    expect(
      sanitizeAssistantFinalAnswerText("<think>hidden</think>Use <think> literally here"),
    ).toBe("Use <think> literally here");
    expect(sanitizeAssistantFinalAnswerText("Before <think>literal tag text after")).toBe(
      "Before <think>literal tag text after",
    );
    expect(
      sanitizeAssistantFinalAnswerText("Visible prefix <thinking><internal>private reflection"),
    ).toBe("Visible prefix");
  });
});

describe("assistantTraceTextFilter streamed projection", () => {
  it.each([
    {
      name: "a real trace head",
      filter: assistantTraceTextFilter,
      prefix: "tool call: hidden\n",
      line: "An ordinary explanation continues with a function call and a tool call.\n",
      suffix: "Done.",
      visiblePrefix: "",
    },
    {
      name: "a completed citation paragraph with unrelated inline code",
      filter: assistantTraceTextFilter,
      prefix: "tool call: hidden\nSee [1] and use `foo`.\n\n",
      line: "An ordinary explanation continues with a function call and a tool call.\n",
      suffix: "Done.",
      visiblePrefix: "See [1] and use `foo`.\n\n",
    },
    {
      name: "a completed image paragraph with unrelated inline code",
      filter: assistantTraceTextFilter,
      prefix: "tool call: hidden\nSee ![photo][id] and use `foo`.\n\n",
      line: "An ordinary explanation continues with a function call and a tool call.\n",
      suffix: "Done.",
      visiblePrefix: "See ![photo][id] and use `foo`.\n\n",
    },
    {
      name: "fenced payload markers",
      filter: plainToolCallTextFilter,
      prefix: "```ts\n",
      line: 'const value = { label: "example", nested: { count: 42 } };\n',
      suffix: "```\nDone.",
      visiblePrefix: "```ts\n",
    },
    {
      name: "indented fenced payload markers",
      filter: plainToolCallTextFilter,
      prefix: "   ~~~ts\n",
      line: 'const value = { label: "example", nested: { count: 42 } };\n',
      suffix: "   ~~~\nDone.",
      visiblePrefix: "   ~~~ts\n",
    },
    {
      name: "a reference definition before fenced payload markers",
      filter: plainToolCallTextFilter,
      prefix: "[id]: /url\n\n```ts\n",
      line: 'const value = { label: "example", nested: { count: 42 } };\n',
      suffix: "```\nDone.",
      visiblePrefix: "[id]: /url\n\n```ts\n",
    },
  ])("bounds canonical work after $name", ({ filter, prefix, line, suffix, visiblePrefix }) => {
    const source = prefix + line.repeat(256) + suffix;
    const projection = createTextProjection([filter]);
    let testedCharacters = 0;
    const probe = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (
      this: RegExp,
      text,
    ) {
      testedCharacters += text.length;
      return this.exec(text) !== null;
    });
    try {
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
    } finally {
      probe.mockRestore();
    }
    expect(projection.text).toBe(visiblePrefix + line.repeat(256) + suffix);
    expect(testedCharacters).toBeGreaterThan(0);
    expect(testedCharacters).toBeLessThan(source.length * 128);
  });

  it.each([" ", "\n"])("bounds trace work for prose separated by %j", (separator) => {
    const source = Array(256)
      .fill("A helper function call returns the tool call payload for the value.")
      .join(separator);
    const projection = createTextProjection([assistantTraceTextFilter]);
    let testedCharacters = 0;
    const probe = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (
      this: RegExp,
      text,
    ) {
      testedCharacters += text.length;
      return this.exec(text) !== null;
    });
    try {
      for (let offset = 0; offset < source.length; offset += 4) {
        projection.append(source.slice(offset, offset + 4));
      }
    } finally {
      probe.mockRestore();
    }
    expect(projection.text).toBe(source);
    expect(testedCharacters).toBeGreaterThan(0);
    expect(testedCharacters).toBeLessThan(source.length * 8);
  });

  it.each([
    [
      "a channel trace line",
      'Visible intro.\ntool call: read {"path":"a.ts"}\nVisible outro.',
      "Visible intro.\nVisible outro.",
    ],
    [
      "a warning trace line",
      "Visible intro.\n⚠️ 🛠️ Exec failed: `x` (exit 1)\nVisible outro.",
      "Visible intro.\nVisible outro.",
    ],
    [
      "a quoted progress line",
      "Visible intro.\n> 📊 Session Status: ok\nVisible outro.",
      "Visible intro.\nVisible outro.",
    ],
    [
      "an indented progress line",
      "Visible intro.\n   📊 Session Status: ok\nVisible outro.",
      "Visible intro.\nVisible outro.",
    ],
    [
      "a marker line that is not a trace line",
      "Visible intro.\n📊 Summary of results\nVisible outro.",
      "Visible intro.\n📊 Summary of results\nVisible outro.",
    ],
    [
      "trace lines inside fenced code",
      "Visible intro.\n```text\n> ⚠️ 🛠️ Exec failed\nfunction_call: example\n```\ntool-result: hidden\nVisible outro.",
      "Visible intro.\n```text\n> ⚠️ 🛠️ Exec failed\nfunction_call: example\n```\nVisible outro.",
    ],
    [
      "a tilde fence split across deltas",
      "~~~\ntool call: example\n~~~\nVisible outro.",
      "~~~\ntool call: example\n~~~\nVisible outro.",
    ],
    [
      "unbounded whitespace before a channel delimiter",
      `Visible intro.\nFUNCTION_CALL${"\t".repeat(80)}= hidden\nVisible outro.`,
      "Visible intro.\nVisible outro.",
    ],
    [
      "trace and payload markers across repeated fence boundaries",
      "tool call: hidden\n```ts\nconst x = { value: 1 };\ntool call: literal\n```\n~~~text\n[tool:read] {}\n~~~\nfunction call: hidden\nDone.",
      "```ts\nconst x = { value: 1 };\ntool call: literal\n```\n~~~text\n[tool:read] {}\n~~~\nDone.",
    ],
    [
      "a provisional closing fence that becomes literal code",
      "tool call: hidden\n````text\ntool call: literal\n````not a close\ntool call: still literal\n````\ntool call: hidden\nDone.",
      "````text\ntool call: literal\n````not a close\ntool call: still literal\n````\nDone.",
    ],
    [
      "multiline inline code gaining ownership",
      "tool call: hidden\nAn open `example\ntool call: literal\nends here`.\nDone.",
      "An open `example\ntool call: literal\nends here`.\nDone.",
    ],
    [
      "a container-owned fence",
      "tool call: hidden\n> ```text\n> tool call: literal\n> { value: 1 }\n> ```\n\nDone.",
      "> ```text\n> tool call: literal\n> { value: 1 }\n> ```\n\nDone.",
    ],
    [
      "CRLF fence boundaries",
      "tool call: hidden\r\n```ts\r\nconst x = {};\r\ntool call: literal\r\n```\r\nDone.",
      "```ts\r\nconst x = {};\r\ntool call: literal\r\n```\r\nDone.",
    ],
    [
      "indented fence boundaries",
      "Intro.\ntool call: hidden\n   ~~~text\ntool call: literal\n   ~~~\ntool call: hidden\nDone.",
      "Intro.\n   ~~~text\ntool call: literal\n   ~~~\nDone.",
    ],
    [
      "a late image reference that revokes inline-code protection",
      "tool call: hidden\n![example `x\ntool call: literal\nx`][id]\n\nAfter\n\n[id]: /url",
      "![example `x\nx`][id]\n\nAfter\n\n[id]: /url",
    ],
    [
      "a late image reference with escaped and code-owned brackets",
      "tool call: hidden\n![a \\[b `]x\ntool call: literal\nx`][id]\n\nAfter\n\n[id]: /url",
      "![a \\[b `]x\nx`][id]\n\nAfter\n\n[id]: /url",
    ],
    [
      "a settled definition before an image reference",
      "tool call: hidden\n\n[id]: /url\n\nIntro.\n\n![example `x\ntool call: literal\nx`][id]\n",
      "[id]: /url\n\nIntro.\n\n![example `x\nx`][id]",
    ],
    [
      "an unfinished image description with nested brackets",
      "tool call: hidden\n\n[id]: /url\n\n![a [b]\nmore\n`x\ntool call: literal\nx`][id]",
      "[id]: /url\n\n![a [b]\nmore\n`x\nx`][id]",
    ],
    [
      "a multiline inline-link title",
      'tool call: hidden\n[label](/url "title\nmore\n`x\ntool call: literal\nx`")',
      '[label](/url "title\nmore\n`x\nx`")',
    ],
    [
      "a definition absorbing its optional next-line title",
      'tool call: hidden\n\n[id]: /url\n"title\nmore\n`x\ntool call: literal\nx`"',
      '[id]: /url\n"title\nmore\n`x\nx`"',
    ],
  ])("projects %s in token-sized chunks", (_name, source, expected) => {
    for (const size of [1, 3, 7]) {
      const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
      let accumulated = "";
      for (let offset = 0; offset < source.length; offset += size) {
        const chunk = source.slice(offset, offset + size);
        accumulated += chunk;
        projection.append(chunk);
        expect(projection.text).toBe(
          sanitizeAssistantVisibleTextWithProfile(accumulated, "delivery", true),
        );
      }
      expect(projection.text).toBe(expected);
    }
  });

  it("resets rejected line heads when an upstream stage replaces text", () => {
    const projection = createTextProjection([assistantTraceTextFilter]);
    expect(projection.append("A tool call in prose.").text).toBe("A tool call in prose.");
    expect(projection.replace("tool call: hidden\nVisible").text).toBe("Visible");
    expect(projection.replace("```\ntool call: literal\n```").text).toBe(
      "```\ntool call: literal\n```",
    );
    expect(projection.append("\ntool call: hidden\nFresh").text).toBe(
      "```\ntool call: literal\n```\nFresh",
    );
    expect(projection.replace("").text).toBe("");
    expect(projection.append("tool call: hidden\nReset").text).toBe("Reset");
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

  it("uses the tool-progress profile to strip scaffolding while preserving progress lines", () => {
    const input =
      '<think>private reasoning</think>\n<tool_call>{"name":"x"}</tool_call>\n🛠️ run git status';

    expect(sanitizeAssistantVisibleTextWithProfile(input, "tool-progress")).toBe(
      "🛠️ run git status",
    );
  });
});
