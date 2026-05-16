import { describe, expect, it } from "vitest";
import { sanitizeCommandInput } from "./sanitize-command.js";

describe("sanitizeCommandInput", () => {
  // 정상 명령 — no-op 검증 (5건)
  it("leaves a clean command untouched", () => {
    expect(sanitizeCommandInput("cat memory/people/이서현.md")).toBe("cat memory/people/이서현.md");
  });

  it("preserves bash pipe |", () => {
    expect(sanitizeCommandInput("ls memory | grep 황선아")).toBe("ls memory | grep 황선아");
  });

  it("preserves complex shell with redirect", () => {
    const cmd = `find memory -name "*.md" -exec grep -l "황선아" {} \\; 2>/dev/null | head -5`;
    expect(sanitizeCommandInput(cmd)).toBe(cmd);
  });

  it("preserves quoted strings with special chars", () => {
    expect(sanitizeCommandInput(`echo "hello | world"`)).toBe(`echo "hello | world"`);
  });

  it("preserves empty input", () => {
    expect(sanitizeCommandInput("")).toBe("");
  });

  // 토큰 누설 — 핵심 차단 (6건)
  it('strips leading <|<|" pattern (observed Gemma4 leak)', () => {
    expect(sanitizeCommandInput('<|<|"grep -r "황선아" claude-ref/ 2>/dev/null | head -n 20')).toBe(
      'grep -r "황선아" claude-ref/ 2>/dev/null | head -n 20',
    );
  });

  it('strips <|"| prefix (observed Gemma4 leak)', () => {
    expect(sanitizeCommandInput('<|"|gcal add --title "상반기 비타민 캠프"')).toBe(
      'gcal add --title "상반기 비타민 캠프"',
    );
  });

  it("strips <|im_start|> wrapper", () => {
    expect(sanitizeCommandInput("<|im_start|>echo hello<|im_end|>")).toBe("echo hello");
  });

  it("strips <|...|> with arbitrary content", () => {
    expect(sanitizeCommandInput("<|whatever|>ls -la")).toBe("ls -la");
  });

  it("strips multiple leaked tokens in mid-command", () => {
    expect(sanitizeCommandInput("cat <|foo|>memory/people<|bar|>/이서현.md")).toBe(
      "cat memory/people/이서현.md",
    );
  });

  it("strips trailing |> remnant", () => {
    expect(sanitizeCommandInput("ls memory/people |>")).toBe("ls memory/people");
  });

  // edge case (3건)
  it("returns original if sanitize produces empty", () => {
    expect(sanitizeCommandInput('<|"|')).toBe('<|"|');
  });

  it("handles non-string gracefully", () => {
    expect(sanitizeCommandInput(undefined as unknown as string)).toBe(undefined);
    expect(sanitizeCommandInput(null as unknown as string)).toBe(null);
  });

  it("preserves Korean text and emoji", () => {
    expect(sanitizeCommandInput('echo "안녕 🌙 황선아"')).toBe('echo "안녕 🌙 황선아"');
  });
});
