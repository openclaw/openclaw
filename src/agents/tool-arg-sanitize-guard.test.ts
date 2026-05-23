import { describe, expect, it } from "vitest";
import {
  type FalseNegativeEvent,
  type ToolArgSanitizeConfig,
  detectFalseNegativePromise,
  looksLikeRetryPromise,
  readEnvConfig,
  readFalseNegativeGuardConfig,
  sanitizeString,
  sanitizeToolArgs,
  sanitizeToolCallArgumentsInMessage,
} from "./tool-arg-sanitize-guard.js";

const baseCfg: ToolArgSanitizeConfig = {
  enabled: true,
  removeSentinel: true,
  removeHtmlTags: true,
  balanceQuote: true,
  htmlAllowlist: new Set<string>(),
  maxFieldLen: 65536,
};

describe("readEnvConfig", () => {
  it("defaults to all rules enabled when env is empty", () => {
    const cfg = readEnvConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.removeSentinel).toBe(true);
    expect(cfg.removeHtmlTags).toBe(true);
    expect(cfg.balanceQuote).toBe(true);
    expect(cfg.maxFieldLen).toBe(65536);
  });

  it("honours OPENCLAW_TOOL_ARG_SANITIZE_GUARD_ENABLED=0", () => {
    const cfg = readEnvConfig({
      OPENCLAW_TOOL_ARG_SANITIZE_GUARD_ENABLED: "0",
    } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
  });

  it("parses html allowlist as a case-insensitive set", () => {
    const cfg = readEnvConfig({
      OPENCLAW_TOOL_ARG_SANITIZE_HTML_ALLOWLIST: "Br, P , Strong",
    } as NodeJS.ProcessEnv);
    expect(cfg.htmlAllowlist.has("br")).toBe(true);
    expect(cfg.htmlAllowlist.has("p")).toBe(true);
    expect(cfg.htmlAllowlist.has("strong")).toBe(true);
    expect(cfg.htmlAllowlist.has("code")).toBe(false);
  });
});

describe("sanitizeString", () => {
  it("S1 removes <<|tool|> sentinel", () => {
    const r = sanitizeString("hello <<|tool|> world", "command", baseCfg);
    expect(r.value).toBe("hello  world");
    expect(r.mutations[0]?.rule).toBe("sentinel");
  });

  it("S2 removes <|end|> sentinel", () => {
    const r = sanitizeString("foo <|end|>bar", "text", baseCfg);
    expect(r.value).toBe("foo bar");
    expect(r.mutations[0]?.rule).toBe("sentinel");
  });

  it("S3 removes </code> html tag", () => {
    const r = sanitizeString("./script.sh add somebody </code>", "command", baseCfg);
    expect(r.value).toBe("./script.sh add somebody ");
    expect(r.mutations.some((m) => m.rule === "html-tag")).toBe(true);
  });

  it("S4 removes self-closing-ish <br> tag", () => {
    const r = sanitizeString("line1<br>line2", "body", baseCfg);
    expect(r.value).toBe("line1line2");
  });

  it("S5 removes tag with attribute", () => {
    const r = sanitizeString('click <a href="x">here</a>', "body", baseCfg);
    expect(r.value).toBe("click here");
  });

  it("S6 preserves allowlisted html tag", () => {
    const cfg: ToolArgSanitizeConfig = { ...baseCfg, htmlAllowlist: new Set(["code"]) };
    const r = sanitizeString("see <code>x</code> ok", "body", cfg);
    expect(r.value).toBe("see <code>x</code> ok");
  });

  it("S7 balances odd unescaped double quotes", () => {
    const r = sanitizeString('say "hello', "body", baseCfg);
    expect(r.value).toBe('say "hello"');
    expect(r.mutations.some((m) => m.rule === "balance-quote")).toBe(true);
  });

  it("S8 leaves even-count quotes alone", () => {
    const r = sanitizeString('say "hello" and "bye"', "body", baseCfg);
    expect(r.value).toBe('say "hello" and "bye"');
    expect(r.mutations.length).toBe(0);
  });

  it('S9 escaped \\" does not count toward unbalanced quotes', () => {
    const r = sanitizeString('json: \\"hello\\"', "body", baseCfg);
    expect(r.value).toBe('json: \\"hello\\"');
    expect(r.mutations.length).toBe(0);
  });

  it("S10 truncates oversize field", () => {
    const cfg: ToolArgSanitizeConfig = { ...baseCfg, maxFieldLen: 10 };
    const r = sanitizeString("0123456789ABCDE", "body", cfg);
    expect(r.value).toBe("0123456789");
    expect(r.mutations.some((m) => m.rule === "truncate")).toBe(true);
  });
});

describe("sanitizeToolArgs", () => {
  it("S11 leaves non-string fields untouched", () => {
    const r = sanitizeToolArgs({ command: "ok", count: 3, flag: true }, "bash", baseCfg);
    expect(r.args.count).toBe(3);
    expect(r.args.flag).toBe(true);
    expect(r.changed).toBe(false);
  });

  it("S12 sanitizes non-standard string fields when contaminated", () => {
    const r = sanitizeToolArgs(
      { custom: "x <<|sentinel|> y" } as Record<string, unknown>,
      "some_tool",
      baseCfg,
    );
    expect(r.args.custom).toBe("x  y");
    expect(r.changed).toBe(true);
  });

  it("S13 leaves clean non-standard string fields untouched", () => {
    const r = sanitizeToolArgs(
      { custom: "plain value" } as Record<string, unknown>,
      "some_tool",
      baseCfg,
    );
    expect(r.args.custom).toBe("plain value");
    expect(r.changed).toBe(false);
  });

  it("S14 reproduces 2026-05-21 13:45 incident: command with </code> leak", () => {
    const args = {
      command: './person.sh add 이서현 -- "오로라 소민 5/18 방문" </code>',
    };
    const r = sanitizeToolArgs(args, "bash", baseCfg);
    expect(r.changed).toBe(true);
    expect(String(r.args.command).includes("</code>")).toBe(false);
    expect(String(r.args.command).includes("이서현")).toBe(true);
  });

  it("S15 handles sentinel+html-tag combination in one field", () => {
    const r = sanitizeToolArgs({ command: "x <<|tool|> y </code> z" }, "bash", baseCfg);
    expect(r.args.command).toBe("x  y  z");
    expect(r.changed).toBe(true);
  });

  it("S16 no-op when guard disabled", () => {
    const cfg: ToolArgSanitizeConfig = { ...baseCfg, enabled: false };
    const r = sanitizeToolArgs({ command: "x <<|leak|>" }, "bash", cfg);
    expect(r.args.command).toBe("x <<|leak|>");
    expect(r.changed).toBe(false);
  });
});

describe("sanitizeToolCallArgumentsInMessage", () => {
  it("rewrites toolCall block arguments in place", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "ok" },
        {
          type: "toolCall",
          name: "bash",
          arguments: { command: "echo hi </code>" },
        },
      ],
    };
    const changed = sanitizeToolCallArgumentsInMessage(message, baseCfg);
    expect(changed).toBe(true);
    const toolBlock = message.content[1] as { arguments: { command: string } };
    expect(toolBlock.arguments.command).toBe("echo hi ");
  });

  it("ignores non-tool-call blocks", () => {
    const message = {
      content: [{ type: "text", text: "raw <<|leak|>" }],
    };
    const changed = sanitizeToolCallArgumentsInMessage(message, baseCfg);
    expect(changed).toBe(false);
  });
});

describe("false negative guard", () => {
  it("readFalseNegativeGuardConfig defaults to warn mode + 10s window", () => {
    const cfg = readFalseNegativeGuardConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.mode).toBe("warn");
    expect(cfg.windowMs).toBe(10000);
  });

  it("looksLikeRetryPromise matches Korean and English retry phrases", () => {
    expect(looksLikeRetryPromise("아, 미안! 다시 시도합니다")).toBe(true);
    expect(looksLikeRetryPromise("재시도 할게요")).toBe(true);
    expect(looksLikeRetryPromise("Let me retry that")).toBe(true);
    expect(looksLikeRetryPromise("I'll try again")).toBe(true);
    expect(looksLikeRetryPromise("just a normal answer")).toBe(false);
  });

  it("F1 detects retry-promise without follow-up toolCall (warn mode)", () => {
    const t0 = 1_000_000;
    const events: FalseNegativeEvent[] = [
      { kind: "toolFailed", at: t0, toolName: "bash", error: "syntax error" },
      { kind: "assistantText", at: t0 + 500, text: "아 미안! 다시 시도합니다" },
    ];
    const r = detectFalseNegativePromise(events, {
      enabled: true,
      mode: "warn",
      windowMs: 10_000,
    });
    expect(r.detected).toBe(true);
    if (r.detected) {
      expect(r.failedToolName).toBe("bash");
      expect(r.action).toBe("warn");
    }
  });

  it("F2 does not flag when a real retry follows within the window", () => {
    const t0 = 1_000_000;
    const events: FalseNegativeEvent[] = [
      { kind: "toolFailed", at: t0, toolName: "bash", error: "syntax error" },
      { kind: "assistantText", at: t0 + 500, text: "다시 시도합니다" },
      { kind: "toolCall", at: t0 + 1500, toolName: "bash" },
    ];
    const r = detectFalseNegativePromise(events, {
      enabled: true,
      mode: "warn",
      windowMs: 10_000,
    });
    expect(r.detected).toBe(false);
  });

  it("F3 honours windowMs - retry after window still flags as false negative", () => {
    const t0 = 1_000_000;
    const events: FalseNegativeEvent[] = [
      { kind: "toolFailed", at: t0, toolName: "bash", error: "syntax error" },
      { kind: "assistantText", at: t0 + 500, text: "다시 시도합니다" },
      { kind: "toolCall", at: t0 + 20_000, toolName: "bash" },
    ];
    const r = detectFalseNegativePromise(events, {
      enabled: true,
      mode: "warn",
      windowMs: 10_000,
    });
    expect(r.detected).toBe(true);
  });

  it("F4 disabled guard returns not-detected", () => {
    const t0 = 1_000_000;
    const events: FalseNegativeEvent[] = [
      { kind: "toolFailed", at: t0, toolName: "bash", error: "syntax error" },
      { kind: "assistantText", at: t0 + 500, text: "다시 시도합니다" },
    ];
    const r = detectFalseNegativePromise(events, {
      enabled: false,
      mode: "warn",
      windowMs: 10_000,
    });
    expect(r.detected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2.18.1 heredoc-variant sentinel: TD18-2 (2026-05-21 17:12 KST live
// regression) reproduced "<<//code>" where the model serialized "</code>"
// into args with an extra "<" prefix. bash then interpreted "<<" as a
// here-doc, reading stdin until EOF and corrupting the command.
// ---------------------------------------------------------------------------

describe("R1.x cmd-prefix sentinel (P6-2)", () => {
  const cases = [
    { id: "CP1", input: "<|find ~/projects -name foo.md", want: "find ~/projects -name foo.md" },
    {
      id: "CP2",
      input: "<|\\find ~/projects -name foo.md",
      want: "\\find ~/projects -name foo.md",
    },
    {
      id: "CP3",
      input: "bash <|scripts/memory.sh on 2026-05-22",
      want: "bash scripts/memory.sh on 2026-05-22",
    },
    {
      id: "CP4",
      input: "normal command without sentinel",
      want: "normal command without sentinel",
    },
    { id: "CP5", input: "<|find foo && <|ls bar", want: "find foo && ls bar" },
  ];
  cases.forEach(({ id, input, want }) => {
    it(id, () => {
      const result = sanitizeString(input, "command", baseCfg);
      expect(result.value).toBe(want);
    });
  });
});

describe("R1.1 heredoc-variant sentinel (TD18-2 regression)", () => {
  it("H1 removes <<//code> heredoc-shaped leak", () => {
    const r = sanitizeString("코드예시 <<//code> P218_MARKER_B_HTMLTAG 끝", "command", baseCfg);
    expect(r.value).toBe("코드예시  P218_MARKER_B_HTMLTAG 끝");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("H2 removes <<TOKEN> heredoc-shaped leak (no slash)", () => {
    const r = sanitizeString("payload <<EOF> body", "command", baseCfg);
    expect(r.value).toBe("payload  body");
  });

  it("H3 does not touch legitimate `<<` in HTML-allowlisted regions (no-op when allowlisted token does not match heredoc shape)", () => {
    // Heredoc shape requires no whitespace inside. "<< X >" has space, no match.
    const r = sanitizeString("text << foo > rest", "command", baseCfg);
    expect(r.value).toBe("text << foo > rest");
  });

  it("H4 detects contamination on non-standard field via heredoc variant", () => {
    const r = sanitizeToolArgs(
      { extra: "x <<//code> y" } as Record<string, unknown>,
      "some_tool",
      baseCfg,
    );
    expect(r.changed).toBe(true);
    expect(r.args.extra).toBe("x  y");
  });

  it("H5 reproduces TD18-2 13:45-style mutated leak with complete sanitize", () => {
    const r = sanitizeToolArgs(
      {
        command:
          "bash scripts/person.sh new P218자가검증B -- 2026-05-21 코드예시 <<//code> P218_MARKER_B_HTMLTAG 끝",
      },
      "bash",
      baseCfg,
    );
    expect(r.changed).toBe(true);
    const out = String(r.args.command);
    expect(out.includes("<<//code>")).toBe(false);
    expect(out.includes("P218_MARKER_B_HTMLTAG")).toBe(true);
    expect(out.includes("끝")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P2.18.2 open-sentinel variant: 18:58 KST live regression (clonari URL).
// Model serialized web_fetch args.url as:
//   "<<|\"|https://clonari.craftbay.io/s/36eea1ea48c1505b\""
// Sentinel marker "<<|\"|" lacks closing ">" so neither RE_SENTINEL_DOUBLE
// (requires "|>") nor RE_SENTINEL_HEREDOC ([^|>\s] bans pipe) catches it.
// RE_SENTINEL_OPEN_* matches "<<|inner|" / "<|inner|" when NOT followed by ">".
// ---------------------------------------------------------------------------

describe("R1.2 open-sentinel variant (clonari URL 18:58 live regression)", () => {
  it('O1 removes <<|"|payload open-double sentinel (TD18.2 live args)', () => {
    const r = sanitizeString(
      '<<|"|https://clonari.craftbay.io/s/36eea1ea48c1505b"',
      "url",
      baseCfg,
    );
    // sentinel stripped; trailing unescaped quote balance-quote will add one
    // more " to make pair (we only assert sentinel removal + payload preserved).
    expect(r.value.includes("<<|")).toBe(false);
    expect(r.value.includes("https://clonari.craftbay.io/s/36eea1ea48c1505b")).toBe(true);
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("O2 removes <|x|payload open-single sentinel", () => {
    const r = sanitizeString("<|x|https://example.com/path", "url", baseCfg);
    expect(r.value).toBe("https://example.com/path");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("O3 closed form <<|x|> still flows through RE_SENTINEL_DOUBLE (no regression)", () => {
    const r = sanitizeString("<<|x|>https://example.com", "url", baseCfg);
    expect(r.value).toBe("https://example.com");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("O4 natural prose '<< foo |' with whitespace is NOT matched", () => {
    // Inner bans whitespace so '<< foo |' (space after '<<' or in inner) skipped.
    // We pick a shape that would only match if whitespace-gating were broken.
    const r = sanitizeString("see <<x | y stuff", "text", baseCfg);
    // The opening "<<x" has no closing "|" right after the inner, so even
    // without whitespace gating it would not match; this case is purely a
    // canary that benign prose containing < and | is untouched.
    expect(r.value).toBe("see <<x | y stuff");
    expect(r.mutations.length).toBe(0);
  });

  it("O5 detects contamination on web_fetch args.url and sanitizes (TD18.2)", () => {
    const r = sanitizeToolArgs(
      { url: '<<|"|https://clonari.craftbay.io/s/36eea1ea48c1505b"' },
      "web_fetch",
      baseCfg,
    );
    expect(r.changed).toBe(true);
    const out = String(r.args.url);
    expect(out.includes("<<|")).toBe(false);
    expect(out.includes("https://clonari.craftbay.io/s/36eea1ea48c1505b")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P2.18.3 nested-sentinel variant: 19:24 KST live regression.
// Model serialized write args.content as: "<|<|\"# 오로라 소민..."
// Outer "<|" opens marker; inner contains another "<" which RE_SENTINEL_
// OPEN_SINGLE's inner ban [^|<>\s] rejects. NESTED variants relax inner to
// ban only "|" and whitespace.
// ---------------------------------------------------------------------------

describe("R1.3 nested-sentinel variant (write content args 19:24 live regression)", () => {
  it('N1 removes <|<|\\"payload nested-single sentinel (TD-RAW-2 live args)', () => {
    const r = sanitizeString(
      '<|<|"# 오로라 소민(이서현) 방문 후기 2026-05-18(월)',
      "content",
      baseCfg,
    );
    expect(r.value.includes("<|<|")).toBe(false);
    expect(r.value.includes("오로라 소민(이서현) 방문 후기")).toBe(true);
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("N2 removes <<|<|payload nested-double sentinel", () => {
    const r = sanitizeString("<<|<|payload here", "content", baseCfg);
    expect(r.value.includes("<<|<|")).toBe(false);
    expect(r.value.includes("payload here")).toBe(true);
  });

  it("N3 natural prose '<x| y' with space inside is NOT matched (whitespace guard)", () => {
    const r = sanitizeString("see <x| y stuff", "text", baseCfg);
    expect(r.value).toBe("see <x| y stuff");
    expect(r.mutations.length).toBe(0);
  });
});

describe("R4 path-quote-strip (P2.19b file_path quote sanitize)", () => {
  it("P1 strips paired double quotes from file_path", () => {
    const r = sanitizeString('"notes/foo.md"', "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("notes/foo.md");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
  });

  it("P2 strips paired single quotes from file_path", () => {
    const r = sanitizeString("'~/relative.md'", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("~/relative.md");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
  });

  it("P3 strips <| sentinel prefix from file_path", () => {
    const r = sanitizeString("<|/abs/path.md", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("/abs/path.md");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
  });

  it("P4 strips <<| sentinel prefix from file_path", () => {
    const r = sanitizeString("<<|/abs/path.md", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("/abs/path.md");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
  });

  it("P5 strips one-side leading dquote (NOT balance-quote appending)", () => {
    const r = sanitizeString('"notes/foo.md', "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("notes/foo.md");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
    expect(r.mutations.some((m) => m.rule === "balance-quote")).toBe(false);
  });

  it("P6 strips one-side trailing dquote (NOT balance-quote)", () => {
    const r = sanitizeString('notes/foo.md"', "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("notes/foo.md");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
    expect(r.mutations.some((m) => m.rule === "balance-quote")).toBe(false);
  });

  it("P7 reproduces jsonl L34 live case (paired dquotes wrapping path)", () => {
    // Real failure: file_path: "\"notes/p219-retry.md\"" - model self-correction
    // wrote a literal "notes/p219-retry.md" (with surrounding dquotes) file.
    const r = sanitizeString('"notes/p219-retry.md"', "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("notes/p219-retry.md");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
  });

  it("P8 normal path unchanged (no false positive)", () => {
    const r = sanitizeString("notes/normal.md", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("notes/normal.md");
    expect(r.mutations.length).toBe(0);
  });

  it("P9 empty path unchanged", () => {
    const r = sanitizeString("", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("");
    expect(r.mutations.length).toBe(0);
  });

  it("P10 sanitizeToolArgs detects file_path field on write tool", () => {
    const r = sanitizeToolArgs({ file_path: '"notes/foo.md"', content: "hello" }, "write");
    expect(r.args.file_path).toBe("notes/foo.md");
    expect(r.changed).toBe(true);
  });

  it("P11 sanitizeToolArgs handles 'path' field too (not just file_path)", () => {
    const r = sanitizeToolArgs({ path: "'~/test.md'" }, "edit");
    expect(r.args.path).toBe("~/test.md");
    expect(r.changed).toBe(true);
  });

  it("P12 balance-quote bypassed on path field with one-side dquote", () => {
    // Without isPath: balance-quote appends a stray dquote -> corrupted path.
    // With isPath: path-quote-strip removes the lone dquote instead.
    const r = sanitizeString('"notes/foo.md', "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("notes/foo.md");
    expect(r.mutations.some((m) => m.rule === "balance-quote")).toBe(false);
  });

  it("P13 path with spaces but no quotes is unchanged", () => {
    const r = sanitizeString("notes/my file.md", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("notes/my file.md");
    expect(r.mutations.length).toBe(0);
  });

  it("P14 double-wrapped quotes (paired-single around paired-double)", () => {
    const r = sanitizeString("'\"x\"'", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("x");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
  });
});

// ===========================================================================
// P2.24c — sentinel orphan-prefix + control-char strip (2026-05-22)
// Regression cases for scenario-07-exec-sentinel-guard failure:
//   raw bytes "3c 7c 0c 69 6e 64" = "<|<\x0c>ind" — sentinel <| followed by
//   form-feed (0x0c). RE_SENTINEL_CMD_PREFIX's `[^\s|>]` lookahead rejected
//   form-feed (\s includes \f), so the sentinel survived sanitize and reached
//   bash unchanged, producing "ind: command not found".
// ===========================================================================
describe("tool-arg-sanitize-guard P2.24c — orphan prefix + control char strip", () => {
  it("C1 scenario-07 exact raw: <|<0x0c>find ~/projects strips to 'find ~/projects'", () => {
    // Raw input as emitted by Gemma4 (after JSON.parse): "<|" + 0x0c + "find ..."
    const raw = "<|\u000cfind ~/projects/openclaw/agents/gemma/workspace";
    const r = sanitizeString(raw, "command", baseCfg);
    expect(r.value).toBe("find ~/projects/openclaw/agents/gemma/workspace");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("C2 double orphan <<|find ... strips to 'find ...'", () => {
    const r = sanitizeString("<<|find /home -name '*.md'", "command", baseCfg);
    expect(r.value).toBe("find /home -name '*.md'");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("C3 single orphan <|find ... (no control char) strips to 'find ...'", () => {
    // Already handled by RE_SENTINEL_CMD_PREFIX (lookahead matches 'f'), but
    // verify R5b also catches it as a last-resort net.
    const r = sanitizeString("<|find /tmp", "command", baseCfg);
    expect(r.value).toBe("find /tmp");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("C4 clean command is passed through unchanged", () => {
    const r = sanitizeString("find /home/lisyoen -name '*.md'", "command", baseCfg);
    expect(r.value).toBe("find /home/lisyoen -name '*.md'");
    expect(r.mutations.length).toBe(0);
  });

  it("C5 multi-line script body preserves \\n and \\t", () => {
    const raw = "set -e\n\tfind /tmp\n\techo done";
    const r = sanitizeString(raw, "script", baseCfg);
    expect(r.value).toBe(raw);
    expect(r.mutations.length).toBe(0);
  });

  it("C6 non-EXEC field (body) — control char strip + CMD_PREFIX still cleans <|<0x0c>text", () => {
    const raw = "<|\u000chello world";
    const r = sanitizeString(raw, "body", baseCfg);
    // R5c strips 0x0c -> "<|hello world" -> CMD_PREFIX (next char 'h' is
    // non-space/pipe/gt) matches -> "hello world"
    expect(r.value).toBe("hello world");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("C7 sanitizeToolArgs end-to-end on exec.command field", () => {
    const raw = "<|\u000cfind ~/projects -name '*.md'";
    const r = sanitizeToolArgs({ command: raw }, "exec");
    expect(r.args.command).toBe("find ~/projects -name '*.md'");
    expect(r.changed).toBe(true);
  });

  it("C8 vertical-tab \\x0b is also stripped", () => {
    const raw = "<|\u000bls /tmp";
    const r = sanitizeString(raw, "command", baseCfg);
    expect(r.value).toBe("ls /tmp");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("C9 EXEC_CMD_SANITIZED_FIELDS strips <| even when surrounded by literal chars (R5b)", () => {
    // Construct a case the standard sentinel regexes miss: "<|" embedded mid-string
    // with no closing |>. RE_SENTINEL_CMD_PREFIX needs lookahead to non-space; this
    // case has "<|" followed by 'x'. R5b is the safety net.
    const r = sanitizeString("ls && <|x && pwd", "command", baseCfg);
    // CMD_PREFIX would also catch this (next char 'x' is non-space), so verify
    // result is clean regardless of which rule applied.
    expect(r.value).toBe("ls && x && pwd");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });
});

describe("R5d trailing-orphan sentinel (P2.24d, gemma write-content live regression)", () => {
  // Live failure case: 2026-05-23 12:44 KST.
  // Gemma4 NVFP4 write tool args.content ended with "\n<|" because the
  // sentinel open-token leaked at final emission. R1 sentinel regexes
  // require paired form or non-empty suffix; R5b orphan strip is gated
  // to EXEC_CMD fields. Result: a 568-byte markdown template was written
  // with literal "<|" appended at end-of-file.
  //
  // jsonl: agents/gemma/sessions/e8d2bd03-3cee-48d5-b380-4bdc1dc92756.jsonl L98
  //   toolName: "write"
  //   arguments.content ends with: "...작성하세요)*\n<|"
  //   arguments.file_path: clean (R4 caught it)
  //   toolResult: isError=false (write succeeded; only content was tainted)

  it("R5d-1 strips trailing <| from content field", () => {
    const r = sanitizeString("# Heading\n\nBody text.\n<|", "content", baseCfg);
    expect(r.value).toBe("# Heading\n\nBody text.\n");
    expect(r.mutations.some((m) => m.rule === "sentinel")).toBe(true);
  });

  it("R5d-2 strips trailing <<| from content field", () => {
    const r = sanitizeString("text\n<<|", "content", baseCfg);
    expect(r.value).toBe("text\n");
  });

  it("R5d-3 strips trailing <| and trailing whitespace, preserves leading whitespace before sentinel", () => {
    // Whitespace BEFORE the sentinel is preserved (could be legitimate
    // body indentation). Whitespace AFTER the sentinel is stripped.
    const r = sanitizeString("text   <|  \n  ", "body", baseCfg);
    expect(r.value).toBe("text   ");
  });

  it("R5d-4 strips trailing <| from text/message/prompt fields", () => {
    expect(sanitizeString("foo<|", "text", baseCfg).value).toBe("foo");
    expect(sanitizeString("foo<|", "message", baseCfg).value).toBe("foo");
    expect(sanitizeString("foo<|", "prompt", baseCfg).value).toBe("foo");
    expect(sanitizeString("foo<|", "query", baseCfg).value).toBe("foo");
  });

  it("R5d-5 preserves mid-content <| (legitimate prose about tokens)", () => {
    // Markdown about LLM tokens may legitimately contain "<|".
    const input = "The token <|im_start|> opens a turn.\n";
    const r = sanitizeString(input, "content", baseCfg);
    // R1 paired "<|im_start|>" should be stripped by RE_SENTINEL_OPEN_SINGLE.
    // The result should NOT have trailing strip activity beyond R1.
    expect(r.value).toBe("The token  opens a turn.\n");
  });

  it("R5d-6 does not touch mid-content <| followed by whitespace (when not at end)", () => {
    // "<|" followed by whitespace escapes R1.x RE_SENTINEL_CMD_PREFIX
    // (which requires [^\s|>] lookahead). R5b is gated to EXEC_CMD fields
    // so content escapes that too. R5d targets end-of-string only — when
    // "<|" is mid-content with a trailing tail after it, R5d must not
    // touch it. Verifies R5d is anchored to $.
    const r = sanitizeString("prefix <| midfix suffix", "content", baseCfg);
    expect(r.value).toBe("prefix <| midfix suffix");
  });

  it("R5d-7 multiple trailing <| forms collapsed", () => {
    const r = sanitizeString("text\n<|<|<|", "content", baseCfg);
    expect(r.value).toBe("text\n");
  });

  it("R5d-8 trailing <| through sanitizeToolArgs on write tool", () => {
    const args = {
      file_path: "memory/notes.md",
      content: "# Notes\n\nBody.\n<|",
    };
    const res = sanitizeToolArgs(args, "write", baseCfg);
    expect(res.changed).toBe(true);
    expect((res.args as { content: string }).content).toBe("# Notes\n\nBody.\n");
    expect((res.args as { file_path: string }).file_path).toBe("memory/notes.md");
  });

  it("R5d-9 path field skipped (R4 handles path-style sentinel prefix)", () => {
    // Trailing "<|" on a path field — R5d skips (options.isPath = true),
    // but R4 path-quote-strip handles it at the start (not end). For end-
    // of-string trailing case, R5d skip is correct: paths shouldn't have
    // trailing "<|" patterns from real models.
    const r = sanitizeString("memory/file.md", "file_path", baseCfg);
    expect(r.value).toBe("memory/file.md");
  });

  it("R5d-10 trailing-only does NOT affect command field beyond R5b", () => {
    // command field already gets R5b global orphan strip. R5d should
    // be a no-op for command fields where R5b already cleaned up.
    const r = sanitizeString("echo hi\n<|", "command", baseCfg);
    expect(r.value).toBe("echo hi\n");
  });
});

describe("R5e trailing-lt (P2.24e, bare trailing < on path fields)", () => {
  it("R5e-1 strips trailing < from file_path (live regression: edit args)", () => {
    // e8d2bd03 jsonl: edit args file_path = "~/projects/openclaw/.../visit_logs.md<"
    const r = sanitizeString("memory/visit_logs.md<", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("memory/visit_logs.md");
    expect(r.mutations.some((m) => m.rule === "path-quote-strip")).toBe(true);
  });

  it("R5e-2 strips multiple trailing < from path", () => {
    const r = sanitizeString("memory/foo.md<<", "file_path", baseCfg, { isPath: true });
    expect(r.value).toBe("memory/foo.md");
  });

  it("R5e-3 does not touch normal path without trailing <", () => {
    const r = sanitizeString("memory/aurora-somin-plan-2026-05-22.md", "file_path", baseCfg, {
      isPath: true,
    });
    expect(r.value).toBe("memory/aurora-somin-plan-2026-05-22.md");
    expect(r.mutations.length).toBe(0);
  });

  it("R5e-4 sanitizeToolArgs catches file_path ending in < (edit tool)", () => {
    const args = {
      file_path: "memory/visit_logs.md<",
      oldText: "some text",
      newText: "new text",
    };
    const result = sanitizeToolArgs(args, "edit");
    expect(result.args.file_path).toBe("memory/visit_logs.md");
    expect(result.changed).toBe(true);
  });

  it("R5e-5 non-path content field trailing < is preserved (legitimate prose)", () => {
    // In non-path fields, trailing "<" is not stripped (only path fields).
    // A content field could end in a math inequality "x < y" which is fine.
    const r = sanitizeString("x < y means smaller", "content", baseCfg);
    expect(r.value).toBe("x < y means smaller");
  });
});
