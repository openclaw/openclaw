// Tool payload tests cover model tool-call schema conversion and compatibility payloads.
import { describe, expect, it } from "vitest";
import {
  extractToolPayload,
  parseStandalonePlainTextToolCallBlocks,
  stripPlainTextToolCallBlocks,
  type ToolPayloadCarrier,
} from "./tool-payload.js";

describe("extractToolPayload", () => {
  it("returns undefined for missing results", () => {
    expect(extractToolPayload(undefined)).toBeUndefined();
    expect(extractToolPayload(null)).toBeUndefined();
  });

  it("prefers explicit details payloads", () => {
    expect(
      extractToolPayload({
        details: { ok: true },
        content: [{ type: "text", text: '{"ignored":true}' }],
      }),
    ).toEqual({ ok: true });
  });

  it("parses JSON text blocks and falls back to raw text, content, or the whole result", () => {
    expect(
      extractToolPayload({
        content: [
          { type: "image", url: "https://example.com/a.png" },
          { type: "text", text: '{"ok":true,"count":2}' },
        ],
      }),
    ).toEqual({ ok: true, count: 2 });

    expect(
      extractToolPayload({
        content: [{ type: "text", text: "not json" }],
      }),
    ).toBe("not json");

    const content = [{ type: "image", url: "https://example.com/a.png" }];
    expect(
      extractToolPayload({
        content,
      }),
    ).toBe(content);

    const result = { status: "ok" } as ToolPayloadCarrier & { status: string };
    expect(extractToolPayload(result)).toBe(result);
  });
});

describe("parseStandalonePlainTextToolCallBlocks", () => {
  it("parses bracketed local-model tool blocks", () => {
    const raw = ["[read]", '{"path":"/tmp/file.txt","line_start":1}', "[END_TOOL_REQUEST]"].join(
      "\n",
    );
    const blocks = parseStandalonePlainTextToolCallBlocks(raw);

    expect(blocks).toEqual([
      {
        name: "read",
        arguments: { path: "/tmp/file.txt", line_start: 1 },
        start: 0,
        end: raw.length,
        raw,
      },
    ]);
  });

  it("parses Harmony commentary tool calls", () => {
    const raw = 'commentary to=read code {"path":"/path/to/file","line_start":1,"line_end":400}';
    const blocks = parseStandalonePlainTextToolCallBlocks(raw);

    expect(blocks).toEqual([
      {
        name: "read",
        arguments: { path: "/path/to/file", line_start: 1, line_end: 400 },
        start: 0,
        end: raw.length,
        raw,
      },
    ]);
  });

  it("parses Harmony marker-wrapped tool calls", () => {
    const raw = '<|channel|>commentary to=read code<|message|>{"path":"/tmp/file.txt"}<|call|>';
    const blocks = parseStandalonePlainTextToolCallBlocks(raw);

    expect(blocks).toEqual([
      {
        name: "read",
        arguments: { path: "/tmp/file.txt" },
        start: 0,
        end: raw.length,
        raw,
      },
    ]);
  });

  it("parses Grok-style bracketed tool calls", () => {
    const firstRaw = '[tool:read] {"path":"/app/skills/meme-maker/SKILL.md"}';
    const secondRaw = '[tool:message] {"action":"send","channel":"channel:123","message":"done"}';
    const raw = [firstRaw, "", secondRaw].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw);

    expect(blocks).toEqual([
      {
        name: "read",
        arguments: { path: "/app/skills/meme-maker/SKILL.md" },
        start: 0,
        end: firstRaw.length,
        raw: firstRaw,
      },
      {
        name: "message",
        arguments: { action: "send", channel: "channel:123", message: "done" },
        start: firstRaw.length + 2,
        end: raw.length,
        raw: secondRaw,
      },
    ]);
  });

  it("parses serialized parameter XML tool calls", () => {
    const firstRaw = [
      "[tool:exec]",
      "<parameter=command>",
      'cat /proc/mounts 2>/dev/null | grep -i "libra|rav|openclaw" | head -20',
      "</parameter>",
      "</function>",
    ].join("\n");
    const secondRaw = [
      "<function=exec>",
      "<parameter=command>",
      'find / -maxdepth 4 -type d \\( -name "ravdb" -o -name "librav" \\) 2>/dev/null | head -20',
      "</parameter>",
      "</function>",
    ].join("\n");
    const raw = [firstRaw, "", secondRaw].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw, {
      allowedToolNames: ["exec"],
    });

    expect(blocks).toEqual([
      {
        name: "exec",
        arguments: {
          command: 'cat /proc/mounts 2>/dev/null | grep -i "libra|rav|openclaw" | head -20',
        },
        start: 0,
        end: firstRaw.length,
        raw: firstRaw,
      },
      {
        name: "exec",
        arguments: {
          command:
            'find / -maxdepth 4 -type d \\( -name "ravdb" -o -name "librav" \\) 2>/dev/null | head -20',
        },
        start: firstRaw.length + 2,
        end: raw.length,
        raw: secondRaw,
      },
    ]);
  });

  it("preserves whitespace inside serialized XML parameter values", () => {
    const raw = [
      "<function=write>",
      "<parameter=content>",
      "  first line",
      "  second line",
      "",
      "</parameter>",
      "</function>",
    ].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw, {
      allowedToolNames: ["write"],
    });

    expect(blocks?.[0]?.arguments).toEqual({
      content: "  first line\n  second line\n",
    });
  });

  it("rejects serialized XML parameter calls without a function close", () => {
    const raw = ["<function=exec>", "<parameter=command>", "pwd", "</parameter>"].join("\n");

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["exec"],
      }),
    ).toBeNull();
  });

  it("parses legacy tool-prefixed XML parameter calls without a function close", () => {
    const raw = ["[tool:exec]", "<parameter=command>", "pwd", "</parameter>"].join("\n");

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["exec"],
      }),
    ).toEqual([
      {
        arguments: { command: "pwd" },
        end: raw.length,
        name: "exec",
        raw,
        start: 0,
      },
    ]);
  });

  it("finds XML parameter close tags without lowercased string offsets", () => {
    const dottedCapitalI = "\u0130";
    const raw = [
      "<function=write>",
      "<parameter=content>",
      dottedCapitalI,
      "</parameter>",
      "</function>",
    ].join("\n");
    const blocks = parseStandalonePlainTextToolCallBlocks(raw, {
      allowedToolNames: ["write"],
    });

    expect(blocks?.[0]?.arguments).toEqual({ content: dottedCapitalI });
  });

  it("rejects XML parameter blocks whose cumulative payload exceeds the cap", () => {
    const firstParameter = ["<parameter=first>", "alpha", "</parameter>"].join("\n");
    const secondParameter = ["<parameter=second>", "beta", "</parameter>"].join("\n");
    const raw = ["<function=write>", firstParameter, secondParameter, "</function>"].join("\n");
    const maxPayloadBytes = Math.max(firstParameter.length, secondParameter.length) + 1;

    expect(
      parseStandalonePlainTextToolCallBlocks(raw, {
        allowedToolNames: ["write"],
        maxPayloadBytes,
      }),
    ).toBeNull();
  });

  it("respects allowed tool names for Harmony calls", () => {
    const blocks = parseStandalonePlainTextToolCallBlocks(
      'commentary to=write code {"path":"/tmp/file.txt","content":"x"}',
      { allowedToolNames: ["read"] },
    );

    expect(blocks).toBeNull();
  });

  it("parses namespaced attribute-dialect invoke tool calls", () => {
    const raw = [
      '<mm:invoke name="exec">',
      '<mm:parameter name="command">',
      "pwd",
      "</mm:parameter>",
      "</mm:invoke>",
    ].join("\n");

    expect(parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["exec"] })).toEqual([
      { name: "exec", arguments: { command: "pwd" }, start: 0, end: raw.length, raw },
    ]);
  });

  it("parses function_calls-wrapped attribute-dialect invoke tool calls", () => {
    const raw = [
      "<function_calls>",
      '<invoke name="read">',
      '<parameter name="path">',
      "src/index.ts",
      "</parameter>",
      "</invoke>",
      "</function_calls>",
    ].join("\n");

    expect(parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["read"] })).toEqual([
      { name: "read", arguments: { path: "src/index.ts" }, start: 0, end: raw.length, raw },
    ]);
  });

  it("parses antml namespaced attribute-dialect invoke tool calls", () => {
    const ns = "antml:";
    const raw = [
      `<${ns}invoke name="exec">`,
      `<${ns}parameter name="command">`,
      "whoami",
      `</${ns}parameter>`,
      `</${ns}invoke>`,
    ].join("\n");

    expect(parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["exec"] })).toEqual([
      { name: "exec", arguments: { command: "whoami" }, start: 0, end: raw.length, raw },
    ]);
  });

  it("parses a bare attribute-dialect invoke with no namespace prefix", () => {
    const raw = '<invoke name="exec"><parameter name="command">v</parameter></invoke>';

    expect(parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["exec"] })).toEqual([
      { name: "exec", arguments: { command: "v" }, start: 0, end: raw.length, raw },
    ]);
  });

  it("parses an antml-prefixed open paired with bare closing tags", () => {
    // Degraded proxies routinely drop the namespace on the close, so mixed
    // open/close prefixes are accepted on purpose.
    const ns = "antml:";
    const raw = `<${ns}invoke name="exec"><${ns}parameter name="command">v</parameter></invoke>`;

    expect(parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["exec"] })).toEqual([
      { name: "exec", arguments: { command: "v" }, start: 0, end: raw.length, raw },
    ]);
  });

  it("parses multiple invoke blocks inside one function_calls wrapper", () => {
    const raw = [
      "<function_calls>",
      '<invoke name="read"><parameter name="path">a.ts</parameter></invoke>',
      '<invoke name="exec"><parameter name="command">ls</parameter></invoke>',
      "</function_calls>",
    ].join("\n");

    const blocks = parseStandalonePlainTextToolCallBlocks(raw, {
      allowedToolNames: ["read", "exec"],
    });

    expect(blocks?.map((block) => ({ name: block.name, arguments: block.arguments }))).toEqual([
      { name: "read", arguments: { path: "a.ts" } },
      { name: "exec", arguments: { command: "ls" } },
    ]);
  });

  it("keeps attribute-dialect parameter values literal up to the first close", () => {
    const value = '{"html":"<div></span>hi</div>","note":"a < b && c > d"}';
    const raw = [
      '<invoke name="write">',
      '<parameter name="content">',
      value,
      "</parameter>",
      "</invoke>",
    ].join("\n");

    const blocks = parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["write"] });

    // Delimiter-based extraction keeps the raw text up to the first </parameter>;
    // nested JSON and angle brackets stay a string with no JSON parsing.
    expect(blocks?.[0]?.arguments).toEqual({ content: value });
  });

  it("does not parse parameterless or self-closing invoke blocks", () => {
    expect(
      parseStandalonePlainTextToolCallBlocks('<invoke name="exec"></invoke>', {
        allowedToolNames: ["exec"],
      }),
    ).toBeNull();
    expect(
      parseStandalonePlainTextToolCallBlocks('<invoke name="exec"/>', {
        allowedToolNames: ["exec"],
      }),
    ).toBeNull();
    // A closed 0-param invoke wrapped in <function_calls> is still argument-less;
    // promotion must reject it even though the strip path treats it as complete.
    expect(
      parseStandalonePlainTextToolCallBlocks(
        '<function_calls><invoke name="read"></invoke></function_calls>',
        { allowedToolNames: ["read"] },
      ),
    ).toBeNull();
  });

  it("rejects attribute-dialect invoke calls with unknown tool names", () => {
    const raw = '<invoke name="write"><parameter name="path">x</parameter></invoke>';

    expect(parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["read"] })).toBeNull();
  });

  it("declines promotion for mixed prose and attribute-dialect invoke text", () => {
    const raw = [
      "Let me check that.",
      '<invoke name="read"><parameter name="path">a.ts</parameter></invoke>',
    ].join("\n");

    expect(parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["read"] })).toBeNull();
  });

  it("does not promote an arbitrary namespace outside the closed allow-list", () => {
    const raw = '<foo:invoke name="exec"><parameter name="command">x</parameter></foo:invoke>';

    expect(parseStandalonePlainTextToolCallBlocks(raw, { allowedToolNames: ["exec"] })).toBeNull();
  });

  it("promotes bare and mixed-prefix invoke open/close pairings", () => {
    // Open and close tags carry the namespace prefix independently. A bare
    // open/bare close and a namespaced open paired with a bare close both
    // promote, because degraded proxies routinely drop the prefix on the close.
    const bare = '<invoke name="exec"><parameter name="p">v</parameter></invoke>';
    expect(parseStandalonePlainTextToolCallBlocks(bare, { allowedToolNames: ["exec"] })).toEqual([
      { name: "exec", arguments: { p: "v" }, start: 0, end: bare.length, raw: bare },
    ]);

    const ns = "antml:";
    const mixed = [
      `<${ns}invoke name="exec">`,
      `<${ns}parameter name="command">`,
      "whoami",
      "</parameter>",
      "</invoke>",
    ].join("\n");
    expect(parseStandalonePlainTextToolCallBlocks(mixed, { allowedToolNames: ["exec"] })).toEqual([
      { name: "exec", arguments: { command: "whoami" }, start: 0, end: mixed.length, raw: mixed },
    ]);
  });
});

describe("stripPlainTextToolCallBlocks", () => {
  it("strips standalone bracketed local-model blocks", () => {
    expect(
      stripPlainTextToolCallBlocks(
        ["before", "[read]", '{"path":"/tmp/file.txt"}', "[END_TOOL_REQUEST]", "after"].join("\n"),
      ),
    ).toBe("before\nafter");
  });

  it("strips standalone Harmony tool calls", () => {
    expect(
      stripPlainTextToolCallBlocks(
        'before\ncommentary to=read code {"path":"/tmp/file.txt"}\nafter',
      ),
    ).toBe("before\nafter");
  });

  it("strips standalone Grok-style tool calls", () => {
    expect(
      stripPlainTextToolCallBlocks(
        [
          "before",
          '[tool:read] {"path":"/tmp/file.txt"}',
          '[tool:message] {"action":"send","message":"[tool:read] {\\"path\\":\\"/tmp/file.txt\\"}"}',
          "after",
        ].join("\n"),
      ),
    ).toBe("before\nafter");
  });

  it("strips serialized tool calls with parameter XML blocks", () => {
    expect(
      stripPlainTextToolCallBlocks(
        [
          "before",
          "[tool:exec]",
          "<parameter=command>",
          'cat /proc/mounts 2>/dev/null | grep -i "libra|rav|openclaw" | head -20',
          "</parameter>",
          "</function>",
          "",
          "<function=exec>",
          "<parameter=command>",
          'find / -maxdepth 4 -type d \\( -name "ravdb" -o -name "librav" \\) 2>/dev/null | head -20',
          "</parameter>",
          "<parameter=timeout_ms>",
          "1000",
          "</parameter>",
          "</function>",
          "after",
        ].join("\n"),
      ),
    ).toBe("before\n\nafter");
  });

  it("keeps legacy bracketed XML parameter blocks scrubbed", () => {
    expect(
      stripPlainTextToolCallBlocks(
        [
          "before",
          "[exec]",
          "<parameter=command>",
          "pwd",
          "</parameter>",
          "</function>",
          "after",
        ].join("\n"),
      ),
    ).toBe("before\nafter");
  });

  it("preserves incomplete XML parameter blocks when stripping visible text", () => {
    const text = ["before", "[exec]", "<parameter=command>", "pwd", "</parameter>", "after"].join(
      "\n",
    );

    expect(stripPlainTextToolCallBlocks(text)).toBe(text);
  });

  it("strips legacy tool-prefixed XML parameter blocks without a function close", () => {
    expect(
      stripPlainTextToolCallBlocks(
        ["before", "[tool:exec]", "<parameter=command>", "pwd", "</parameter>", "after"].join("\n"),
      ),
    ).toBe("before\nafter");
  });

  it("strips oversized XML parameter tool calls without promoting them", () => {
    const largeValue = "x".repeat(140_000);
    const block = [
      "<function=write>",
      "<parameter=first>",
      largeValue,
      "</parameter>",
      "<parameter=second>",
      largeValue,
      "</parameter>",
      "</function>",
    ].join("\n");

    expect(
      parseStandalonePlainTextToolCallBlocks(block, {
        allowedToolNames: ["write"],
      }),
    ).toBeNull();
    expect(stripPlainTextToolCallBlocks(["before", block, "after"].join("\n"))).toBe(
      "before\nafter",
    );
  });

  it("strips namespaced attribute-dialect invoke blocks from visible text", () => {
    const raw = [
      "before",
      '<mm:invoke name="exec">',
      '<mm:parameter name="command">',
      "pwd",
      "</mm:parameter>",
      "</mm:invoke>",
      "after",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe("before\nafter");
  });

  it("strips function_calls-wrapped attribute-dialect invoke blocks from visible text", () => {
    const raw = [
      "before",
      "<function_calls>",
      '<invoke name="read">',
      '<parameter name="path">',
      "src/index.ts",
      "</parameter>",
      "</invoke>",
      "</function_calls>",
      "after",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe("before\nafter");
  });

  it("strips multiple invoke blocks sharing one function_calls wrapper from visible text", () => {
    const raw = [
      "before",
      "<function_calls>",
      '<invoke name="read"><parameter name="path">a.ts</parameter></invoke>',
      '<invoke name="exec"><parameter name="command">ls</parameter></invoke>',
      "</function_calls>",
      "after",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe("before\nafter");
  });

  it("leaves an arbitrary namespace outside the closed allow-list as prose", () => {
    const raw = [
      "before",
      '<foo:invoke name="exec"><parameter name="command">x</parameter></foo:invoke>',
      "after",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("preserves a line-leading invoke block followed by same-line prose", () => {
    const raw =
      '<invoke name="find"><parameter name="query">x</parameter></invoke> is the attribute form.';

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("preserves a line-leading function_calls wrapper followed by same-line prose", () => {
    const raw =
      '<function_calls><invoke name="read"><parameter name="path">a.ts</parameter></invoke></function_calls> shows the wrapper.';

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("strips a real standalone invoke block on its own line", () => {
    const raw = [
      "before",
      '<invoke name="exec">',
      '<parameter name="command">ls</parameter>',
      "</invoke>",
      "after",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe("before\nafter");
  });

  it("preserves a mid-line invoke example in prose", () => {
    const raw = 'The syntax <invoke name="x"><parameter name="y">z</parameter></invoke> is used.';

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("preserves a fenced multiline namespaced invoke example", () => {
    // A complete multiline invoke inside a Markdown fence is documentation, not
    // a #97750 degraded leak. The public wrapper is code-aware by default, so it
    // must leave fenced examples untouched.
    const raw = [
      "The attribute dialect looks like:",
      "```",
      '<mm:invoke name="exec">',
      '<mm:parameter name="command">',
      "pwd",
      "</mm:parameter>",
      "</mm:invoke>",
      "```",
      "done",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("preserves a fenced multiline plain invoke example", () => {
    const raw = [
      "Example:",
      "```",
      '<invoke name="read">',
      '<parameter name="path">src/index.ts</parameter>',
      "</invoke>",
      "```",
      "done",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("preserves an inline-code invoke example on its own line", () => {
    const raw = [
      "Use this:",
      '`<invoke name="exec"><parameter name="command">ls</parameter></invoke>`',
      "done",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("still strips an unfenced standalone invoke block while preserving its fenced sibling", () => {
    const raw = [
      "```",
      '<invoke name="exec">',
      '<parameter name="command">pwd</parameter>',
      "</invoke>",
      "```",
      '<invoke name="exec">',
      '<parameter name="command">pwd</parameter>',
      "</invoke>",
      "after",
    ].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe(
      [
        "```",
        '<invoke name="exec">',
        '<parameter name="command">pwd</parameter>',
        "</invoke>",
        "```",
        "after",
      ].join("\n"),
    );
  });

  it("strips standalone closed zero-parameter invoke blocks", () => {
    // A complete, argument-less invoke is a #97750 degraded leak, not an example;
    // scrub the bare, wrapped, and namespaced closed forms from visible text.
    expect(
      stripPlainTextToolCallBlocks(["before", '<invoke name="read"></invoke>', "after"].join("\n")),
    ).toBe("before\nafter");
    expect(
      stripPlainTextToolCallBlocks(
        ["before", '<function_calls><invoke name="read"></invoke></function_calls>', "after"].join(
          "\n",
        ),
      ),
    ).toBe("before\nafter");
    expect(
      stripPlainTextToolCallBlocks(
        ["before", '<mm:invoke name="read"></mm:invoke>', "after"].join("\n"),
      ),
    ).toBe("before\nafter");
    expect(
      stripPlainTextToolCallBlocks(["before", '<invoke name="read"></invoke>', "after"].join("\n")),
    ).toBe("before\nafter");
  });

  it("strips a standalone self-closing invoke block", () => {
    expect(
      stripPlainTextToolCallBlocks(["before", '<invoke name="read"/>', "after"].join("\n")),
    ).toBe("before\nafter");
  });

  it("preserves a line-leading closed zero-parameter invoke followed by same-line prose", () => {
    const raw = '<invoke name="read"></invoke> trailing prose stays.';

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it("preserves a fenced closed zero-parameter invoke example", () => {
    const raw = ["Example:", "```", '<invoke name="read"></invoke>', "```", "done"].join("\n");

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });
});
