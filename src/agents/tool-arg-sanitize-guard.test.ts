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
