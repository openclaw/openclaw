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
  it('returns "" for sentinel-only residue (rule 5 강화, 2026-05-19)', () => {
    // 룰5 강화 전엔 추적 위해 원본을 반환했으나, sentinel-only 잔재는
    // bash syntax error 만 유발하므로 이제 빈 문자열을 반환한다.
    expect(sanitizeCommandInput('<|"|')).toBe("");
  });

  it("handles non-string gracefully", () => {
    expect(sanitizeCommandInput(undefined as unknown as string)).toBe(undefined);
    expect(sanitizeCommandInput(null as unknown as string)).toBe(null);
  });

  it("preserves Korean text and emoji", () => {
    expect(sanitizeCommandInput('echo "안녕 🌙 황선아"')).toBe('echo "안녕 🌙 황선아"');
  });

  // 더블 less-than 변형 — 2026-05-17 11:13 재발 (8건)
  it('strips leading <<|"| variant (double less-than, no closing |>)', () => {
    expect(sanitizeCommandInput('<<|"|x')).toBe("x");
  });

  it("strips leading <<| with no closing", () => {
    expect(sanitizeCommandInput("<<|x")).toBe("x");
  });

  it("strips a leading double less-than run", () => {
    expect(sanitizeCommandInput("<<x")).toBe("x");
  });

  it("strips a leading triple less-than run", () => {
    expect(sanitizeCommandInput("<<<x")).toBe("x");
  });

  it('strips mid-command <<|"| variant', () => {
    expect(sanitizeCommandInput('x<<|"|y')).toBe("xy");
  });

  it("preserves a lone leading unmatched quote (false-positive guard)", () => {
    expect(sanitizeCommandInput('"unmatched')).toBe('"unmatched');
  });

  it('strips trailing <<|"| remnant', () => {
    expect(sanitizeCommandInput('x<<|"|')).toBe("x");
  });

  it("preserves html-like <x> text (false-positive guard)", () => {
    expect(sanitizeCommandInput("<x>")).toBe("<x>");
  });
});

describe("sentinel residue handling (5/19 황선아 환각 회귀)", () => {
  it('empty for sentinel-only residue: <<|"|>', () => {
    expect(sanitizeCommandInput('<<|"|>')).toBe("");
  });
  it("empty for double-lt residue: <<", () => {
    expect(sanitizeCommandInput("<<")).toBe("");
  });
  it("empty for sentinel-only mix: <|>", () => {
    expect(sanitizeCommandInput("<|>")).toBe("");
  });
  // jsonl 격리본 실측 exec command 값 (cc1646c8…hallucinated, 2026-05-19 17:02).
  // 이 잔재가 bash 로 흘러가 syntax error → 모델이 황선아 환각 답변 생성.
  it('empty for observed jsonl exec residue: <|<|"|', () => {
    expect(sanitizeCommandInput('<|<|"|')).toBe("");
  });
  it("preserves single < (could be valid redirect target)", () => {
    expect(sanitizeCommandInput("<")).toBe("<");
  });
  it("preserves bash heredoc with EOF marker", () => {
    expect(sanitizeCommandInput("cat <<EOF\nhello\nEOF")).toBe("cat <<EOF\nhello\nEOF");
  });
  it("preserves bash input redirect", () => {
    expect(sanitizeCommandInput("cat <file.txt")).toBe("cat <file.txt");
  });
});
