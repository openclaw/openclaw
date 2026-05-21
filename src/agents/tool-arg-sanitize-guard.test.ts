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
