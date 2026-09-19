import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "./redact.js";

describe("custom adjacent-class redaction", () => {
  it("keeps custom adjacent-class redaction patterns active", () => {
    const secret = "corp-ABCDEFGHIJKLMNOP";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["corp-[A-Z]+[A-Z]+"],
    });
    expect(output).not.toContain(secret);
    expect(output).toContain("corp-");
  });

  it("keeps disjoint escaped custom redaction alternatives active", () => {
    const secret = "corp-ABCD";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["corp-(\\x41|BCD)+"],
    });
    expect(output).not.toContain(secret);
    expect(output).toContain("corp-");
  });

  it("drops overlapping noncapturing custom redaction alternatives", () => {
    const secret = "aaaaX";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["(?:a|aaa)+"],
    });
    expect(output).toContain(secret);
  });

  it("keeps lookahead-prefixed deterministic custom redaction alternatives active", () => {
    const secret = "corp-ab";
    const longer = "corp-acde";
    const output = redactSensitiveText(`id=${secret} also=${longer}`, {
      mode: "tools",
      patterns: ["corp-((?=a)ab|acde)+"],
    });
    expect(output).not.toContain(secret);
    expect(output).not.toContain(longer);
    expect(output).toContain("corp-");
  });

  it("keeps disjoint octal custom redaction alternatives active", () => {
    const secret = "corp-aBCD";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["corp-(\\141|BCD)+"],
    });
    expect(output).not.toContain(secret);
    expect(output).toContain("corp-");
  });

  it("drops word-boundary overlapping custom redaction alternatives", () => {
    const secret = "ababX";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["(a\\Bb|abab)+"],
    });
    expect(output).toContain(secret);
  });

  it("drops leftover-octal overlapping custom redaction alternatives", () => {
    const secret = "a4ca4cX";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["(\\1414c|a4ca4c)+"],
    });
    expect(output).toContain(secret);
  });

  it("drops inline case-flag overlapping custom redaction alternatives", () => {
    const secret = "AAX";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["((?i:a)|AA)+"],
    });
    expect(output).toContain(secret);
  });

  it("drops class control-escape overlapping custom redaction alternatives", () => {
    const secret = "\x1f\x1fX";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["([\\c_]|\\x1f\\x1f)+"],
    });
    expect(output).toContain(secret);
  });

  it("drops non-Unicode property identity-escape overlapping custom redaction alternatives", () => {
    const secret = "p{L}cp{L}cX";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["(\\p{L}c|p{L}cp{L}c)+"],
    });
    expect(output).toContain(secret);
  });

  it("drops mixed Unicode code-point overlapping custom redaction alternatives", () => {
    const secret = "😀😀X";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["/(\\u{1F600}|😀😀)+/u"],
    });
    expect(output).toContain(secret);
  });

  it("drops overlapping astral class-range custom redaction alternatives", () => {
    const secret = "😀😀X";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["/([😀-🙏]|😀😀)+/u"],
    });
    expect(output).toContain(secret);
  });

  it("drops overlapping escaped surrogate-pair custom redaction alternatives", () => {
    const secret = "😀😀X";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["/(\\uD83D\\uDE00|😀😀)+/u"],
    });
    expect(output).toContain(secret);
  });

  it("drops overlapping astral case-folding custom redaction alternatives", () => {
    const secret = "𐐨𐐨X";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["/([𐐀]|𐐨𐐨)+/iu"],
    });
    expect(output).toContain(secret);
  });

  it("drops malformed control-escape overlapping custom redaction alternatives", () => {
    const secret = "\\c\\cX";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["(\\c|\\\\c\\\\c)+"],
    });
    expect(output).toContain(secret);
  });

  it("drops multiline-anchor overlapping custom redaction alternatives", () => {
    const secret = "\na\naZ";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["/(\\n^a|\\na\\na)+Z/m"],
    });
    expect(output).toContain(secret);
  });

  it("drops equal-length lookaround overlapping custom redaction alternatives", () => {
    const secret = "aaaaX";
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: ["(a|a(?=a))+"],
    });
    expect(output).toContain(secret);
  });

  it("keeps a long custom redaction literal active", { timeout: 2000 }, () => {
    const secret = `corp-${"A".repeat(20_000)}`;
    const output = redactSensitiveText(`id=${secret}`, {
      mode: "tools",
      patterns: [secret],
    });
    expect(output).not.toContain(secret);
    expect(output).toContain("corp-");
  });
});
