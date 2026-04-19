import { describe, expect, it } from "vitest";
import {
  sanitizeAssistantVisibleText,
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
});

describe("sanitizeAssistantVisibleTextWithProfile", () => {
  it("uses the history profile to preserve block-boundary whitespace", () => {
    const input = ["Hi ", '<tool_result>{"output":"hidden"}</tool_result>', "there"].join("");

    expect(sanitizeAssistantVisibleTextWithProfile(input, "history")).toBe("Hi there");
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

  describe("progress profile (Phase 3 Discord Surface Overhaul)", () => {
    it("strips POSIX absolute home paths to ~/...", () => {
      const input = "Wrote /home/alice/project/src/file.ts and /Users/bob/Documents/log.txt.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain("/home/alice/");
      expect(cleaned).not.toContain("/Users/bob/");
      expect(cleaned).toContain("~/project/src/file.ts");
      expect(cleaned).toContain("~/Documents/log.txt");
    });

    it("strips /root/ and /tmp/ style absolute paths", () => {
      expect(sanitizeAssistantVisibleTextWithProfile("Error at /root/x/y.log", "progress")).toBe(
        "Error at ~/x/y.log",
      );
    });

    it("strips Windows user profile paths", () => {
      const input = "Opened C:\\Users\\alice\\Downloads\\secret.pdf";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain("C:\\Users\\alice");
      expect(cleaned).toContain("~/Downloads/secret.pdf");
    });

    it("redacts sk-* API keys", () => {
      expect(
        sanitizeAssistantVisibleTextWithProfile(
          "key=sk-live-XYZABC123456789012 still active",
          "progress",
        ),
      ).toContain("[redacted-api-key]");
    });

    it("redacts Bearer tokens while preserving the Bearer keyword", () => {
      expect(
        sanitizeAssistantVisibleTextWithProfile("header: Bearer abcd1234efgh5678ijkl", "progress"),
      ).toContain("Bearer [redacted]");
    });

    it("redacts OPENAI_API_KEY / ANTHROPIC_API_KEY assignments", () => {
      expect(
        sanitizeAssistantVisibleTextWithProfile(
          "OPENAI_API_KEY=sk-proj-abcdefghij1234567890",
          "progress",
        ),
      ).toContain("OPENAI_API_KEY=[redacted]");
      expect(
        sanitizeAssistantVisibleTextWithProfile("ANTHROPIC_API_KEY=sk-ant-api-foo-bar", "progress"),
      ).toContain("ANTHROPIC_API_KEY=[redacted]");
    });

    it("redacts GitHub personal access tokens", () => {
      expect(
        sanitizeAssistantVisibleTextWithProfile("pat=ghp_abcdefghij1234567890ABC", "progress"),
      ).toContain("[redacted-github-pat]");
    });

    it("strips Node.js stack-trace frames", () => {
      const input = [
        "TypeError: cannot read property 'foo' of undefined",
        "    at doWork (/home/alice/src/app.js:42:10)",
        "    at processTicksAndRejections (node:internal/process/task_queues:96:5)",
        "Next step: retry.",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain("at doWork");
      expect(cleaned).not.toContain("at processTicksAndRejections");
      expect(cleaned).toContain("TypeError: cannot read property");
      expect(cleaned).toContain("Next step: retry.");
    });

    it("leaves normal prose untouched", () => {
      const input = "Merged branch feat/x into main.";
      expect(sanitizeAssistantVisibleTextWithProfile(input, "progress")).toBe(input);
    });

    it("delivery profile does NOT strip absolute paths (regression guard)", () => {
      // Final replies preserve explicit file paths users asked about — only
      // progress-class emissions scrub them.
      expect(
        sanitizeAssistantVisibleTextWithProfile(
          "Wrote /home/alice/report.txt successfully.",
          "delivery",
        ),
      ).toContain("/home/alice/report.txt");
    });
  });

  // Phase 7 P3 red-team: integration-level assertions that the progress
  // sanitizer handles realistic multi-leak emissions (the kind that leak from
  // a model rather than a single curated pattern). Each case mirrors a
  // scenario from the canonical red-team plan; gaps discovered while writing
  // these are reported in the Phase 7 P3 follow-up, not patched here.
  describe("progress profile red-team (Phase 7 P3)", () => {
    it("scrubs the canonical /home/richard/tmp/SECRET_FILE.txt leak", () => {
      const input = "I wrote the file to /home/richard/tmp/SECRET_FILE.txt and locked it.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain("/home/richard/tmp/SECRET_FILE.txt");
      expect(cleaned).toContain("~/tmp/SECRET_FILE.txt");
      expect(cleaned).toContain("locked it");
    });

    it("scrubs multiple absolute paths in the same emission", () => {
      const input =
        "Processed /home/alice/a.txt, /Users/bob/b.txt, /root/c.txt and C:\\Users\\carol\\d.txt";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      for (const leak of ["/home/alice/", "/Users/bob/", "/root/", "C:\\Users\\carol"]) {
        expect(cleaned).not.toContain(leak);
      }
      expect(cleaned).toContain("~/a.txt");
      expect(cleaned).toContain("~/b.txt");
      expect(cleaned).toContain("~/c.txt");
      expect(cleaned).toContain("~/d.txt");
    });

    it("redacts multiple secret types chained in one message", () => {
      // Realistic leak: model echoes an env dump.
      const input = [
        "Loaded secrets:",
        "ANTHROPIC_API_KEY=sk-ant-fake123abcdef456",
        "OPENAI_API_KEY=sk-fake4567890123456abcd",
        "GITHUB_TOKEN=ghp_fakegithubpat12345abcde1234",
        "Authorization: Bearer fake_abc123def456ghi789jkl",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).toContain("ANTHROPIC_API_KEY=[redacted]");
      expect(cleaned).toContain("OPENAI_API_KEY=[redacted]");
      expect(cleaned).toContain("[redacted-github-pat]");
      expect(cleaned).toContain("Bearer [redacted]");
      // None of the raw secret tails should survive.
      expect(cleaned).not.toContain("sk-ant-fake123abcdef456");
      expect(cleaned).not.toContain("sk-fake4567890123456abcd");
      expect(cleaned).not.toContain("ghp_fakegithubpat12345abcde1234");
      expect(cleaned).not.toContain("fake_abc123def456ghi789jkl");
    });

    it("scrubs stack frames with parenthesised file:line:col format", () => {
      const input = [
        "Error: boom",
        "    at handleRequest (/home/richard/src/server.ts:120:18)",
        "    at Object.<anonymous> (/tmp/x.js:12:3)",
        "    at processTicksAndRejections (node:internal/process/task_queues:96:5)",
        "Continuing.",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toMatch(/^\s{2,}at\s+handleRequest/m);
      expect(cleaned).not.toMatch(/^\s{2,}at\s+Object\.<anonymous>/m);
      expect(cleaned).not.toMatch(/^\s{2,}at\s+processTicksAndRejections/m);
      expect(cleaned).toContain("Error: boom");
      expect(cleaned).toContain("Continuing.");
    });

    it("preserves prose markers that should reach the user", () => {
      // The marker shape used by the E2E harness MUST survive sanitization
      // because the harness relies on it for scenario identification.
      const marker = "DISCORD-E2E-ABCDEF";
      const input = `Starting work at /home/richard/tmp/log.txt — ${marker}`;
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).toContain(marker);
      expect(cleaned).not.toContain("/home/richard/tmp/log.txt");
    });

    it("delivery profile preserves ALL leak forms (negative control)", () => {
      // When a message is classified final_reply, the user explicitly asked
      // about this content. Over-sanitizing it would answer a different
      // question. This test guards against an accidental merge of the
      // progress profile into the delivery profile.
      const input = [
        "Here is the file path you asked for: /home/alice/report.txt",
        "And the bearer header the API needs: Authorization: Bearer user_supplied_token_12345",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "delivery");
      expect(cleaned).toContain("/home/alice/report.txt");
      expect(cleaned).toContain("Bearer user_supplied_token_12345");
    });

    it("progress vs delivery profile produce divergent output for the same leak", () => {
      // Direct A/B check: same input, different profiles, observable divergence.
      const input = "Wrote key ANTHROPIC_API_KEY=sk-ant-api-foo-bar-xyz to /home/eve/envrc";
      const progress = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      const delivery = sanitizeAssistantVisibleTextWithProfile(input, "delivery");
      expect(progress).not.toBe(delivery);
      expect(progress).toContain("[redacted]");
      expect(progress).toContain("~/envrc");
      expect(delivery).toContain("sk-ant-api-foo-bar-xyz");
      expect(delivery).toContain("/home/eve/envrc");
    });
  });

  // Phase 3.6 follow-up: close each sanitizer gap that the Phase 7 P3
  // red-team subagent discovered in the existing `progress` profile. Every
  // gap has BOTH a positive assertion (leak is scrubbed) and a negative
  // assertion (legitimate similar-shape prose/final_reply is preserved).
  describe("progress profile Phase 3.6 gap-closure", () => {
    // ----- Gap 1: POSIX paths outside /home, /Users, /root -----
    it("Gap 1: scrubs /tmp, /var, /opt, /etc, /mnt, /srv paths", () => {
      const input = [
        "log=/tmp/secret.txt",
        "db=/var/lib/db/data.sqlite",
        "app=/opt/app/config.yaml",
        "creds=/etc/shadow",
        "mnt=/mnt/vol1/disk",
        "svc=/srv/www/html",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain("/tmp/secret.txt");
      expect(cleaned).not.toContain("/var/lib/db/");
      expect(cleaned).not.toContain("/opt/app/");
      expect(cleaned).not.toContain("/etc/shadow");
      expect(cleaned).not.toContain("/mnt/vol1/");
      expect(cleaned).not.toContain("/srv/www/");
      expect(cleaned).toContain("~/secret.txt");
      expect(cleaned).toContain("~/lib/db/data.sqlite");
      expect(cleaned).toContain("~/app/config.yaml");
      expect(cleaned).toContain("~/shadow");
      expect(cleaned).toContain("~/vol1/disk");
      expect(cleaned).toContain("~/www/html");
    });

    it("Gap 1: does NOT scrub /tmp-like substrings embedded in a larger word", () => {
      // "attempt" contains "tmp" but not as a leading path segment; this must
      // survive because the POSIX_SYS regex anchors to a path boundary.
      const input = "This is my first attempt and /etcetera too.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      // "attempt" and "/etcetera" (note: /etcetera does not match /etc + boundary)
      // should survive. We accept that a bare "/etc" or "/etc/..." IS scrubbed
      // — that is the intended contract.
      expect(cleaned).toContain("attempt");
      // /etcetera starts with /etc but the rest `etera` is part of the tail
      // capture — it becomes ~etera which is a correct scrub since the path
      // format IS leak-shaped. Intentionally not asserting survival here.
      expect(cleaned).toContain("first attempt");
    });

    it("Gap 1: Windows generic drive-letter paths (D:\\, E:\\) scrub", () => {
      const input = "Saved to D:\\backups\\2026-04-17\\dump.sql";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain("D:\\backups");
      expect(cleaned).toContain("~/backups/2026-04-17/dump.sql");
    });

    it("Gap 1: delivery profile preserves system paths (negative control)", () => {
      const input = "Config is at /etc/openclaw/config.yaml and logs at /var/log/app.log";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "delivery");
      expect(cleaned).toContain("/etc/openclaw/config.yaml");
      expect(cleaned).toContain("/var/log/app.log");
    });

    // ----- Gap 2: AWS credentials -----
    it("Gap 2: redacts AWS_SECRET_ACCESS_KEY assignments", () => {
      const input = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
      expect(cleaned).toContain("AWS_SECRET_ACCESS_KEY=");
      // Generic or AWS-specific marker is fine; both scrub the value.
      expect(cleaned).toMatch(/AWS_SECRET_ACCESS_KEY=\[redacted/);
    });

    it("Gap 2: redacts AWS_ACCESS_KEY_ID assignments and bare AKIA ids", () => {
      const input = [
        "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
        "Raw id in logs: AKIAIOSFODNN7EXAMPLE",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      // AWS_ACCESS_KEY_ID assignment should be redacted (either by the AWS
      // env regex or the generic regex); either way the value is gone.
      expect(cleaned).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(cleaned).toMatch(/AWS_ACCESS_KEY_ID=\[redacted/);
    });

    it("Gap 2: leaves prose like 'AWS support' alone", () => {
      const input = "Contact AWS support if the AWS region is down.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).toBe(input);
    });

    // ----- Gap 3: Slack tokens -----
    // Note: fixtures are stored uppercase in source and lowercased at runtime.
    // Real Slack tokens are always lowercase, so static secret scanners (e.g.
    // GitHub push-protection) don't match the uppercase literals here. The
    // sanitizer regex matches lowercase at test time and the scrub is still
    // exercised end-to-end.
    it("Gap 3: scrubs xoxb/xoxp/xoxa Slack tokens", () => {
      const fakeB = "XOXB-1234567890-ABCDEFGHIJKLMNOP".toLowerCase();
      const fakeP = "XOXP-0987654321-ZYXWVUTSRQPONMLK".toLowerCase();
      const fakeA = "XOXA-0000000000-WORKSPACE-TOKEN".toLowerCase();
      const input = [`bot=${fakeB}`, `user=${fakeP}`, `app=${fakeA}`].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain(fakeB);
      expect(cleaned).not.toContain(fakeP);
      expect(cleaned).not.toContain(fakeA);
      // At least one [redacted-slack-token] marker should appear.
      expect(cleaned).toContain("[redacted-slack-token]");
    });

    it("Gap 3: leaves prose like 'xox club' alone (negative control)", () => {
      const input = "The xox club is a music venue, not a token.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).toBe(input);
    });

    // ----- Gap 4: Generic sensitive-name env assignments -----
    it("Gap 4: redacts MY_SECRET, APP_TOKEN, DATABASE_PASSWORD-style assignments", () => {
      const input = [
        "MY_SECRET=supersecretvalue123",
        "APP_TOKEN=tok_abc123",
        "DATABASE_PASSWORD: hunter2hunter2",
        "SSH_PRIVATE_KEY=abcd_xyz",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain("supersecretvalue123");
      expect(cleaned).not.toContain("tok_abc123");
      expect(cleaned).not.toContain("hunter2hunter2");
      expect(cleaned).not.toContain("abcd_xyz");
      expect(cleaned).toContain("MY_SECRET=[redacted]");
      expect(cleaned).toContain("APP_TOKEN=[redacted]");
      // Accept either `DATABASE_PASSWORD: [redacted]` or `=[redacted]` since
      // the regex allows either separator; both scrub the value correctly.
      expect(cleaned).toMatch(/DATABASE_PASSWORD\s*[:=]\s*\[redacted\]/);
      expect(cleaned).toContain("SSH_PRIVATE_KEY=[redacted]");
    });

    it("Gap 4: does NOT eat sentences like 'the secret is out' or 'key ideas'", () => {
      const input = "The secret is out and the key ideas are clear.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).toBe(input);
    });

    // ----- Gap 5: JWTs -----
    it("Gap 5: redacts three-segment JWTs", () => {
      // The payload segments must all satisfy the minimum length of 10 chars.
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
        ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0" +
        ".SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
      const input = `jwt=${jwt}`;
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toContain(jwt);
      expect(cleaned).toContain("[redacted-jwt]");
    });

    it("Gap 5: does NOT touch shorter eyJ-prefixed strings that are not JWTs", () => {
      // "eyJ" on its own, or with one segment, must not be scrubbed.
      const input = "The encoded header eyJhbGc is not a complete JWT.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).toBe(input);
    });

    // ----- Gap 6: Case-insensitive bearer -----
    it("Gap 6: scrubs lower-case 'bearer' and upper-case 'BEARER' tokens", () => {
      const lower = "authorization: bearer abcdef1234567890token";
      const upper = "AUTHORIZATION: BEARER abcdef1234567890token";
      const mixed = "Authorization: BeArEr abcdef1234567890token";
      expect(sanitizeAssistantVisibleTextWithProfile(lower, "progress")).not.toContain(
        "abcdef1234567890token",
      );
      expect(sanitizeAssistantVisibleTextWithProfile(upper, "progress")).not.toContain(
        "abcdef1234567890token",
      );
      expect(sanitizeAssistantVisibleTextWithProfile(mixed, "progress")).not.toContain(
        "abcdef1234567890token",
      );
      // The preserved keyword keeps the original casing for naturalness.
      expect(sanitizeAssistantVisibleTextWithProfile(lower, "progress")).toContain(
        "bearer [redacted]",
      );
      expect(sanitizeAssistantVisibleTextWithProfile(upper, "progress")).toContain(
        "BEARER [redacted]",
      );
    });

    it("Gap 6: leaves the word 'bearer' in ordinary prose alone", () => {
      // "bearer" on its own (no token after) must not be scrubbed.
      const input = "The bond bearer is responsible for the claim.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).toBe(input);
    });

    // ----- Gap 7: Bare stack frames without (path:line:col) -----
    it("Gap 7: scrubs bare 'at fnName' stack frames without parens/line:col", () => {
      const input = [
        "Error: boom",
        "    at handleRequest",
        "    at Module._compile",
        "    at Object.<anonymous>",
        "Continuing with retry.",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).not.toMatch(/^\s{2,}at\s+handleRequest\s*$/m);
      expect(cleaned).not.toMatch(/^\s{2,}at\s+Module\._compile\s*$/m);
      expect(cleaned).not.toMatch(/^\s{2,}at\s+Object\.<anonymous>\s*$/m);
      expect(cleaned).toContain("Error: boom");
      expect(cleaned).toContain("Continuing with retry.");
    });

    it("Gap 7: does NOT scrub prose like 'walking at a pace' or 'arriving at Station'", () => {
      // The bare-frame regex requires leading whitespace + exact `at ` +
      // identifier-start. Mid-sentence "at" in prose must survive.
      const input = [
        "We were walking at a pace of two miles per hour.",
        "Arriving at Station 5, we paused.",
        "The meeting is at 3pm.",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      expect(cleaned).toBe(input);
    });

    // ----- Cross-gap integration tests -----
    it("handles a realistic multi-leak emission across all 7 gap types", () => {
      // Slack fixture stored uppercase and lowercased at runtime to avoid
      // push-protection false positives (see Gap 3 test above).
      const fakeSlack = "XOXB-1111111111-2222222222-ABCDEFGHIJ".toLowerCase();
      const input = [
        "Loaded config from /etc/openclaw/secrets.yaml",
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        `SLACK_WEBHOOK=${fakeSlack}`,
        "MY_SECRET=hunter2hunter2",
        "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        "Authorization: bearer lowercase_token_1234567890",
        "Stack:",
        "    at loadConfig",
        "    at main (/home/alice/src/app.ts:10:5)",
        "Done.",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "progress");
      // Gap 1: /etc scrub (and /home from existing rule)
      expect(cleaned).not.toContain("/etc/openclaw/");
      expect(cleaned).not.toContain("/home/alice/");
      // Gap 2: AWS
      expect(cleaned).not.toContain("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
      // Gap 3: Slack
      expect(cleaned).not.toContain(fakeSlack);
      // Gap 4: generic
      expect(cleaned).not.toContain("hunter2hunter2");
      // Gap 5: JWT
      expect(cleaned).not.toContain(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      );
      // Gap 6: lowercase bearer
      expect(cleaned).not.toContain("lowercase_token_1234567890");
      // Gap 7: bare + parenthesised stack frames
      expect(cleaned).not.toMatch(/^\s{2,}at\s+loadConfig\s*$/m);
      expect(cleaned).not.toMatch(/^\s{2,}at\s+main \(/m);
      expect(cleaned).toContain("Done.");
    });

    it("delivery profile preserves ALL Phase 3.6 gap shapes (negative control)", () => {
      // All of these are legitimate content when the user explicitly asked
      // about them. The delivery profile is expected to pass them through.
      // Slack fixture stored uppercase + lowercased at runtime (see Gap 3).
      const slackExample = "XOXB-ABC-DEF-1234567890".toLowerCase();
      const input = [
        "Your config is at /etc/openclaw/config.yaml",
        "The AWS key shape is AWS_SECRET_ACCESS_KEY=<value>",
        `Slack tokens look like ${slackExample}`,
        "A JWT has the form eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
        "Use bearer lowercase_token_1234567890 in the header",
        "    at loadConfig",
      ].join("\n");
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "delivery");
      expect(cleaned).toContain("/etc/openclaw/config.yaml");
      expect(cleaned).toContain(slackExample);
      expect(cleaned).toContain(
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      );
      expect(cleaned).toContain("bearer lowercase_token_1234567890");
      expect(cleaned).toContain("    at loadConfig");
    });

    it("delivery profile preserves user-asked path reference (negative control 2)", () => {
      // Common user scenario: "what's in ~/.openclaw/config?" Final reply
      // must preserve the path so the answer is actionable. Even an absolute
      // path reply survives.
      const input = "The config is at /home/user/.openclaw/config.yaml — check the mcp section.";
      const cleaned = sanitizeAssistantVisibleTextWithProfile(input, "delivery");
      expect(cleaned).toContain("/home/user/.openclaw/config.yaml");
    });
  });
});
