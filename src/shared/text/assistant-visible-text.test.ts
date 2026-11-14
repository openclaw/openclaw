import { describe, expect, it } from "vitest";
import {
  assistantTraceTextFilter,
  assistantVisibleTextFilters,
  minimaxToolCallTextFilter,
  plainToolCallTextFilter,
  sanitizeAssistantVisibleText,
  sanitizeAssistantVisibleTextWithProfile,
  stripAssistantInternalScaffolding,
  stripToolCallXmlTags,
  type AssistantVisibleTextSanitizerProfile,
} from "./assistant-visible-text.js";
import { regexWork, streamChunks } from "./streaming.test-support.js";
import { createTextProjection, type TextFilter } from "./text-projection.js";

function expectBoundedWork(filter: TextFilter, source: string, expected: string, budget: number) {
  const projection = createTextProjection([filter]);
  const testedCharacters = regexWork(() => streamChunks(source, 4, projection));
  expect(projection.text).toBe(expected);
  expect(testedCharacters).toBeGreaterThan(0);
  expect(testedCharacters).toBeLessThan(source.length * budget);
}

function expectChunkedProjection(source: string, size: number, expected: string) {
  const projection = createTextProjection(assistantVisibleTextFilters("delivery", true));
  streamChunks(source, size, projection, (result, end) => {
    expect(result.text).toBe(
      sanitizeAssistantVisibleTextWithProfile(source.slice(0, end), "delivery", true),
    );
  });
  expect(projection.text).toBe(expected);
}

it("keeps an invisible stream pending until visible text arrives and honors replacements", () => {
  const stream = createTextProjection(assistantVisibleTextFilters("delivery"));
  expect(stream.append("\u200b")).toEqual({ text: "", delta: "" });
  expect(stream.append("👩‍💻")).toEqual({ text: "\u200b👩‍💻", delta: "\u200b👩‍💻" });
  expect(stream.replace("\u2060")).toEqual({ text: "", delta: null });
});

it("keeps plain-tool code protection independent across interleaved streams and replacements", () => {
  const literal = createTextProjection([plainToolCallTextFilter]);
  const hidden = createTextProjection([plainToolCallTextFilter]);
  const opening = "```text\n[tool:read] ";
  literal.append(opening);
  hidden.append("Before\n[tool:read] ");
  const payload = "{}\n";
  expect(literal.append(payload).text).toBe(opening + payload);
  expect(hidden.append(payload + "After").text).toBe("Before\nAfter");

  expect(hidden.replace("[tool:read] {}\n").text).toBe("");
  expect(literal.append("```\n").text).toBe(opening + payload + "```\n");
  expect(hidden.append("Fresh").text).toBe("Fresh");
});

it.each([1, 7, 32])(
  "preserves Markdown and strips bracket payloads in %i-character chunks",
  (size) => {
    const literal = '[read]\n{"path":"example.txt"}\n[/read]';
    const visible = `[guide](https://example.test)\n\n\`\`\`text\n${literal}\n\`\`\`\n\nAfter`;
    const raw = `${visible}\n[tool:read]{"path":"hidden.txt"}\nDone`;
    expectChunkedProjection(raw, size, `${visible}\nDone`);
  },
);

it.each([" \t\n", "\u0085\u200b \u200c\u200d\u2060\ufeff \u200e\u2066\u2069\ufe0f"])(
  "does not present invisible-only assistant output %j as an answer",
  (text) => {
    expect(sanitizeAssistantVisibleText(text)).toBe("");
    expect(sanitizeAssistantVisibleTextWithProfile(text, "final-answer-delivery")).toBe("");
  },
);

it.each(["word\u200bbreak", "👩‍💻", "می‌روم"])(
  "preserves Unicode formatting within visible answers %j",
  (text) => expect(sanitizeAssistantVisibleText(text)).toBe(text),
);

describe("stripAssistantInternalScaffolding", () => {
  it.each([
    ["Hello\n<relevant-memories>\ninternal-only", "Hello\n"],
    [
      "<thinking>\nsecret\n</thinking>\n   \n<relevant-memories>\ninternal note\n</relevant-memories>\n  Visible",
      "  Visible",
    ],
    ['Prefix\n<tool_result> {"output": "data"} </tool_call>\nSuffix', "Prefix\n\nSuffix"],
    ['Before\n[TOOL_CALL]{tool => "web_search", args => {"query":"NET stock price"}', "Before\n"],
    ['<tool_call><parameter name="token">secret</parameter>', ""],
    ['Prefix\n<tool_call>{"name":"x"}</tool_result>LEAK</tool_call>\nSuffix', "Prefix\n\nSuffix"],
    [
      'Use <tool_call to invoke tools.\n<tool_call>{"name":"find"}</tool_call>',
      "Use <tool_call to invoke tools.\n",
    ],
    [
      'Use </tool_call to explain tags.\n<tool_call>{"name":"find"}</tool_call>',
      "Use </tool_call to explain tags.\n",
    ],
    ['prefix\n<function_calls id="x"\n[{"name":"find"}]', "prefix\n"],
    [
      "prefix\n<tool_call>\n" +
        JSON.stringify({ html: '"</tool_call>', tail: "</tool_call> still hidden" }) +
        "\n</tool_call>\nsuffix",
      "prefix\n\nsuffix",
    ],
    ["prefix </tool_call> suffix", "prefix  suffix"],
    ['Before\n[TOOL_RESULT]{"output":"secret result"}[/TOOL_RESULT]\nAfter', "Before\n\nAfter"],
  ] as const)("strips internal scaffolding: %j", (input, expected) => {
    expect(stripAssistantInternalScaffolding(input)).toBe(expected);
  });

  const parameter = '<parameter name="path">/tmp</parameter>';
  it.each([
    "```xml\n<relevant-memories>\nsample\n</relevant-memories>\n```\n\nVisible text",
    'prefix\n<function name="spawn">\n<parameter name="key">value</parameter>',
    "Use <function_response>ok</function_response> to describe the response wrapper.",
    '```text\n[TOOL_CALL]{tool => "web_search", args => {"query":"x"}}[/TOOL_CALL]\n```\nVisible',
    `Use \`${parameter}\`.`,
    `Use <function name="read">${parameter}</function> in docs.`,
    `<schema>${parameter}</schema>`,
    '<schema><parameter name="path"/></schema>',
  ])("preserves literal markup: %j", (input) =>
    expect(stripAssistantInternalScaffolding(input)).toBe(input),
  );

  it.each([
    [
      'Results: <parameter name="assumptions">some content</parameter> after.',
      "Results: some content after.",
    ],
    ['<parameter name="assumptions">\nline 1\nline 2\n</parameter>', "line 1\nline 2"],
    ['Results:<parameter name="x">\nline\n</parameter>after', "Results:\nline\nafter"],
    [`<br>${parameter}`, "<br>/tmp"],
    [`Use <function> declarations. ${parameter}`, "Use <function> declarations. /tmp"],
    [`<schema><other data="</schema>">${parameter}`, '<schema><other data="</schema>">/tmp'],
    ['`<schema data="` <parameter>x</parameter> "></schema>', '`<schema data="` x "></schema>'],
    ["<schema>`</schema>`<parameter>x</parameter>", "<schema>`</schema>`x"],
  ])(
    "unwraps standalone parameters without disturbing surrounding text (#98557): %j",
    (input, expected) => {
      expect(stripAssistantInternalScaffolding(input)).toBe(expected);
    },
  );
});

describe("stripToolCallXmlTags", () => {
  it.each(["<tool_call>", " \n<tool_call>\n ", "<TOOL_CALL>"])(
    "hides a bare unfinished tool-call transport marker: %j",
    (text) => {
      expect(stripToolCallXmlTags(text)).toBe("");
    },
  );

  it.each([
    "`<tool_call>`",
    "```xml\n<tool_call>\n```",
    "    <tool_call>",
    "\t<tool_call>",
    "The marker is <tool_call>.",
    "<tool_call> is a transport marker.",
  ])("preserves literal tool-call documentation: %j", (text) => {
    expect(stripToolCallXmlTags(text)).toBe(text);
    expect(sanitizeAssistantVisibleTextWithProfile(text, "delivery")).toBe(text);
  });

  it("strips compact function_response after a newline-separated stripped function_calls block", () => {
    const input =
      'Checking. <function_calls><invoke name="exec">internal</invoke></function_calls>\n<function_response>ok</function_response>\nAfter';
    expect(stripToolCallXmlTags(input, { stripFunctionCallsXmlPayloads: true })).toBe(
      "Checking. \n\nAfter",
    );
  });

  it.each([
    [
      'prefix <antml:invoke name="exec"><function_call>test</function_call></antml:invoke> suffix',
      "prefix  suffix",
    ],
    ["<parameter note=unquoted <span>visible</span></parameter>"],
    ['<parameter note="<>">next</parameter>', "next"],
    [
      '\ud800🦊<parameter note="<>"/>one<parameter note=\'><\'>two</parameter><tool_call note=">"/>🦊\udfff',
      "\ud800🦊onetwo🦊\udfff",
    ],
  ])("handles nested, malformed and self-closing XML: %j", (input, expected = input) => {
    expect(stripToolCallXmlTags(input)).toBe(expected);
  });
});

it("preserves minimax tool-call XML examples inside inline and fenced code", () => {
  const inline = 'Use `<minimax:tool_call><invoke name="exec">x</invoke></minimax:tool_call>`.';
  const fenced =
    '```xml\n<minimax:tool_call><invoke name="exec">x</invoke></minimax:tool_call>\n```';
  expect(minimaxToolCallTextFilter().transform(inline)).toBe(inline);
  expect(minimaxToolCallTextFilter().transform(fenced)).toBe(fenced);
});

describe("sanitizeAssistantVisibleText", () => {
  it.each([
    ["Tool Result", "[Tool Result for ID abc]\nstdout: hello"],
    ["Tool Call and Arguments", '[Tool Call: bash (ID: 7)]\nArguments: {"cmd":"ls"}'],
  ])("preserves fenced %s logs", (_name, log) => {
    const input = "Log format explainer:\n\n```text\n" + log + "\n```\n\nThen we continue.";
    expect(sanitizeAssistantVisibleText(input)).toBe(input);
  });

  it.each([
    ['prefix <function_calls><invoke name="find">secret</invoke></function_calls> suffix'],
    ["[Tool Result for ID abc]\nstdout: hello", ""],
    [
      [
        '<invoke name="read">payload</invoke></minimax:tool_call>',
        '<tool_result>{"output":"hidden"}</tool_result>',
        "[Tool Call: read (ID: toolu_1)]",
        'Arguments: {"path":"/tmp/x"}',
        "<think>secret</think>",
        "OK",
      ].join("\n"),
      "OK",
    ],
    [
      '<function_calls><invoke name="exec">internal</invoke></function_calls><function_response>\nSearching for: "what skills matter most in the age of AI"\n</function_response>\nOK',
      "OK",
    ],
  ])("sanitizes delivery text: %j", (input, expected = input) => {
    expect(sanitizeAssistantVisibleText(input)).toBe(expected);
  });

  it("strips internal tool trace warning lines on the delivery path", () => {
    const input = [
      "A",
      "⚠️ 🛠️ `run openclaw definitely-not-a-real-subcommand (agent)` failed",
      "⚠️ 🛠️ gh search issues --repo openclaw/openclaw --state open --no-search-pages.jsonl /tmp/openclaw_open_unlabeled_current.json (agent) failed",
      "⚠️ 🛠️ gh search issues --repo openclaw/openclaw --state open (agent) failed: command timed out",
      "⚠️ 🛠️ Exec failed: `python3 /path/to/daily-cost-audit.py` (exit 1)",
      "⚠️ 🛠️ Bash failed: `git status` (workspace) (exit 1)",
      "⚠️ 🛠️ Exec failed (exit 1)",
      "⚠️ 🛠️ Bash failed",
      "🛠️ run git status",
      "Z",
    ].join("\n");

    expect(sanitizeAssistantVisibleText(input)).toBe("A\nZ");
  });
});

describe("assistantTraceTextFilter streamed projection", () => {
  const prose = "An ordinary explanation continues with a function call and a tool call.\n";
  const code = 'const value = { label: "example", nested: { count: 42 } };\n';

  it.each([
    ["a real trace head", "", prose, "", true],
    ["a citation paragraph", "See [1] and use `foo`.\n\n", prose, "", true],
    ["an image paragraph", "See ![photo][id] and use `foo`.\n\n", prose, "", true],
    ["fenced payload markers", "```ts\n", code, "```\n", false],
    ["indented fenced payload markers", "   ~~~ts\n", code, "   ~~~\n", false],
    ["a reference before fenced markers", "[id]: /url\n\n```ts\n", code, "```\n", false],
  ] as const)("bounds canonical work after %s", (_name, prefix, line, closing, trace) => {
    const expected = prefix + line.repeat(256) + closing + "Done.";
    expectBoundedWork(
      trace ? assistantTraceTextFilter : plainToolCallTextFilter,
      (trace ? "tool call: x\n" : "") + expected,
      expected,
      128,
    );
  });

  it.each([" ", "\n"])("bounds trace work for prose separated by %j", (separator) => {
    const source = Array(256)
      .fill("A helper function call returns the tool call payload for the value.")
      .join(separator);
    expectBoundedWork(assistantTraceTextFilter, source, source, 8);
  });

  it.each([
    ['A\ntool call: read {"path":"a.ts"}\nZ', "A\nZ"],
    ["A\n⚠️ 🛠️ Exec failed: `x` (exit 1)\nZ", "A\nZ"],
    ["A\n> 📊 Session Status: ok\nZ", "A\nZ"],
    ["A\n   📊 Session Status: ok\nZ", "A\nZ"],
    ["A\n📊 Summary of results\nZ", "A\n📊 Summary of results\nZ"],
    [
      "A\n```text\n> ⚠️ 🛠️ Exec failed\nfunction_call: example\n```\ntool-result: hidden\nZ",
      "A\n```text\n> ⚠️ 🛠️ Exec failed\nfunction_call: example\n```\nZ",
    ],
    ["~~~\ntool call: example\n~~~\nZ", "~~~\ntool call: example\n~~~\nZ"],
    [`A\nFUNCTION_CALL${"\t".repeat(80)}= hidden\nZ`, "A\nZ"],
    [
      "tool call: x\n```ts\nconst x = { value: 1 };\ntool call: y\n```\n~~~text\n[tool:read] {}\n~~~\nfunction call: z\nDone.",
      "```ts\nconst x = { value: 1 };\ntool call: y\n```\n~~~text\n[tool:read] {}\n~~~\nDone.",
    ],
    [
      "tool call: x\n````text\ntool call: y\n````not a close\ntool call: still y\n````\ntool call: x\nDone.",
      "````text\ntool call: y\n````not a close\ntool call: still y\n````\nDone.",
    ],
    [
      "tool call: x\nAn open `example\ntool call: y\nends here`.\nDone.",
      "An open `example\ntool call: y\nends here`.\nDone.",
    ],
    [
      "tool call: x\n> ```text\n> tool call: y\n> { value: 1 }\n> ```\n\nDone.",
      "> ```text\n> tool call: y\n> { value: 1 }\n> ```\n\nDone.",
    ],
    [
      "tool call: x\r\n```ts\r\nconst x = {};\r\ntool call: y\r\n```\r\nDone.",
      "```ts\r\nconst x = {};\r\ntool call: y\r\n```\r\nDone.",
    ],
    [
      "Intro.\ntool call: x\n   ~~~text\ntool call: y\n   ~~~\ntool call: x\nDone.",
      "Intro.\n   ~~~text\ntool call: y\n   ~~~\nDone.",
    ],
    [
      "tool call: x\n![example `x\ntool call: y\nx`][id]\n\nAfter\n\n[id]: /url",
      "![example `x\nx`][id]\n\nAfter\n\n[id]: /url",
    ],
    [
      "tool call: x\n![a \\[b `]x\ntool call: y\nx`][id]\n\nAfter\n\n[id]: /url",
      "![a \\[b `]x\nx`][id]\n\nAfter\n\n[id]: /url",
    ],
    [
      "tool call: x\n\n[id]: /url\n\nIntro.\n\n![example `x\ntool call: y\nx`][id]\n",
      "[id]: /url\n\nIntro.\n\n![example `x\nx`][id]",
    ],
    [
      "tool call: x\n\n[id]: /url\n\n![a [b]\nmore\n`x\ntool call: y\nx`][id]",
      "[id]: /url\n\n![a [b]\nmore\n`x\nx`][id]",
    ],
    [
      'tool call: x\n[label](/url "title\nmore\n`x\ntool call: y\nx`")',
      '[label](/url "title\nmore\n`x\nx`")',
    ],
    [
      'tool call: x\n\n[id]: /url\n"title\nmore\n`x\ntool call: y\nx`"',
      '[id]: /url\n"title\nmore\n`x\nx`"',
    ],
  ])("projects %j in token-sized chunks", (source, expected) => {
    for (const size of [1, 3, 7]) {
      expectChunkedProjection(source, size, expected);
    }
  });

  it("resets rejected line heads when an upstream stage replaces text", () => {
    const projection = createTextProjection([assistantTraceTextFilter]);
    expect(projection.append("A tool call in prose.").text).toBe("A tool call in prose.");
    expect(projection.replace("tool call: x\nVisible").text).toBe("Visible");
    expect(projection.replace("```\ntool call: y\n```").text).toBe("```\ntool call: y\n```");
    expect(projection.append("\ntool call: x\nFresh").text).toBe("```\ntool call: y\n```\nFresh");
    expect(projection.replace("").text).toBe("");
    expect(projection.append("tool call: x\nReset").text).toBe("Reset");
  });
});

describe("sanitizeAssistantVisibleTextWithProfile", () => {
  it.each([
    [
      "delivery",
      "(**bold<|assistant|>**). First<|user|><|assistant|>second `x<|assistant|>y`",
      "(**bold**). First second `x<|assistant|>y`",
    ],
    ["history", "private chain of thought </think> OK", " OK"],
    [
      "tool-progress",
      '<think>private reasoning</think>\n<tool_call>{"name":"x"}</tool_call>\n🛠️ run git status',
      "🛠️ run git status",
    ],
    [
      "final-answer-delivery",
      "<think>hidden</think>Use <think> literally here",
      "Use <think> literally here",
    ],
    [
      "final-answer-delivery",
      "Before <think>literal tag text after",
      "Before <think>literal tag text after",
    ],
    [
      "final-answer-delivery",
      "Visible prefix <thinking><internal>private reflection",
      "Visible prefix",
    ],
  ] satisfies ReadonlyArray<readonly [AssistantVisibleTextSanitizerProfile, string, string]>)(
    "sanitizes %s text: %j",
    (profile, input, expected) => {
      expect(sanitizeAssistantVisibleTextWithProfile(input, profile)).toBe(expected);
    },
  );
});
