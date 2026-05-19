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

// P2.11 — args-start sentinel variants observed in the 2026-05-19 22:38 KST
// hallucination-test jsonl (gemma session e8d2bd03). Each name cites the
// jsonl line + UTC timestamp the leaked argument was emitted. 471fc7133e
// sanitize left these as broken bash (`ls -|ls -l`, leading-orphan `<ls ...`).
describe("P2.11 args-start sentinel variants (jsonl e8d2bd03, 2026-05-19)", () => {
  it('L252 13:38:10 jsonl: <<|"<<|<|"ls -|<|"ls -l journal/ ... → valid bash', () => {
    expect(
      sanitizeCommandInput('<<|"<<|<|"ls -|<|"ls -l journal/ 2>/dev/null | grep 2026-05-18'),
    ).toBe("ls -ls -l journal/ 2>/dev/null | grep 2026-05-18");
  });

  it('L254 13:38:11 jsonl: <<|"|>ls -ls -l journal/ | grep ... (leading-orphan <)', () => {
    expect(sanitizeCommandInput('<<|"|>ls -ls -l journal/ | grep 2026-05-18')).toBe(
      "ls -ls -l journal/ | grep 2026-05-18",
    );
  });

  it('L256 13:38:12 jsonl x7: <<|"|>ls -ls -l journal/2026-05-18*', () => {
    expect(sanitizeCommandInput('<<|"|>ls -ls -l journal/2026-05-18*')).toBe(
      "ls -ls -l journal/2026-05-18*",
    );
  });

  it('L258 13:38:13 jsonl: <<|"|>ls ... grep "2026-05-18 (trailing model quote kept)', () => {
    expect(sanitizeCommandInput('<<|"|>ls -ls -l journal/ | grep "2026-05-18')).toBe(
      'ls -ls -l journal/ | grep "2026-05-18',
    );
  });

  it('L116 12:18:32 jsonl: <|<|"|>ls -lls -lt journal/ | head -n 5', () => {
    expect(sanitizeCommandInput('<|<|"|>ls -lls -lt journal/ | head -n 5')).toBe(
      "ls -lls -lt journal/ | head -n 5",
    );
  });

  it('L14 11:22:08 jsonl x43: <|<|"grep ... || echo "Not found (|| OR preserved)', () => {
    expect(
      sanitizeCommandInput('<|<|"grep -r "황선아" claude-ref/ 2>/dev/null || echo "Not found'),
    ).toBe('grep -r "황선아" claude-ref/ 2>/dev/null || echo "Not found');
  });

  it('L118 12:18:33 jsonl x61: read file_path <|"| → "" (sentinel-only)', () => {
    expect(sanitizeCommandInput('<|"|')).toBe("");
  });

  it('L6 11:22:04 jsonl: read file_path <|<| → "" (sentinel-only)', () => {
    expect(sanitizeCommandInput("<|<|")).toBe("");
  });

  // 정상 입력 회귀 안전망 — sanitize 강화가 정당한 bash 를 깨면 안 됨.
  it("guard: heredoc cat <<EOF is untouched", () => {
    expect(sanitizeCommandInput("cat <<EOF\nhello\nEOF")).toBe("cat <<EOF\nhello\nEOF");
  });

  it("guard: quoted heredoc cat << 'EOF' is untouched", () => {
    expect(sanitizeCommandInput("cat << 'EOF'\nfoo\nEOF")).toBe("cat << 'EOF'\nfoo\nEOF");
  });

  it("guard: pipe ls -la | grep foo is untouched", () => {
    expect(sanitizeCommandInput("ls -la | grep foo")).toBe("ls -la | grep foo");
  });

  it("guard: redirect echo hello > /tmp/x is untouched", () => {
    expect(sanitizeCommandInput("echo hello > /tmp/x")).toBe("echo hello > /tmp/x");
  });

  it("guard: unmatched quote is not truncated", () => {
    expect(sanitizeCommandInput('echo "unclosed quote')).toBe('echo "unclosed quote');
  });

  it("guard: bash OR || is not stripped", () => {
    expect(sanitizeCommandInput("grep x f || echo none")).toBe("grep x f || echo none");
  });
});
