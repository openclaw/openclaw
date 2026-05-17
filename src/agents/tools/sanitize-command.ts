/**
 * Sanitize a shell command before execution.
 *
 * Strips LLM special tokens (e.g. `<|...|>`, `<|<|"`, `<\|"|`, and the
 * double-less-than variants `<<|"|`, `<<|`, `<<`, `<<<`) that some smaller
 * models (Gemma 4, etc.) occasionally leak into tool call arguments. These
 * tokens cause bash to fail with syntax errors, which in turn forces the model
 * to hallucinate answers it could not retrieve.
 *
 * No-op for clean commands. Safe to apply unconditionally.
 *
 * Mirrors the approach in `sanitize-url.ts` (commit 7cbc14d38).
 */
export function sanitizeCommandInput(raw: string): string {
  if (typeof raw !== "string") {
    return raw;
  }
  if (raw.length === 0) {
    return raw;
  }

  let s = raw;

  // 1) `<|...|>` 형태 special token 전체 제거 (greedy 아님 — 가장 짧게 매칭)
  //    Llama family: <|im_start|>, <|im_end|>, <|eot_id|>, ...
  //    Gemma 변형: <|...|>, <|<|...|>, ...
  s = s.replace(/<\|[^|>]*\|>/g, "");

  // 2) 시작부 sentinel run 제거.
  //    명령 시작에 붙는 `<`, `|`, `"` 연속 run 을 본다.
  //    token-like 일 때만 제거 (run 길이 >= 2 AND `<` 포함) →
  //    단독 `<file` 입력 redirect 나 단독 선행 따옴표(`"unmatched`)는 보존하면서
  //    `<|"|`, `<|<|"`, `<<|"|`, `<<`, `<<<` 등 누설 패턴만 제거.
  const lead = s.match(/^[<|"]+/);
  if (lead && lead[0].length >= 2 && lead[0].includes("<")) {
    s = s.slice(lead[0].length);
  }

  // 3) 중간 더블 less-than 변형 `<<|...|` (Gemma 2026-05-17 11:13 재발 관찰).
  //    `<<` 직후 `|` 가 와야 매칭 → heredoc(`cat <<EOF`)은 건드리지 않음.
  s = s.replace(/<<+\|[^|]*\|?/g, "");

  // 4) 토큰 잔재 / 누설 패턴 제거
  //    관찰: `<|"|`, `<|<|"`, `<|<|`, `|>`, `<|`
  //    명령 시작·중간 어디든 가능. 단 `|` 단독은 파이프이므로 절대 건드리지 않음.
  s = s.replace(/<\|"?\|?/g, ""); // <|" | <|" | <|
  s = s.replace(/\|>/g, ""); // |>

  // 5) 결과가 비었거나 공백만 남으면 원본 반환 (오류 메시지 추적 가능하게)
  const trimmed = s.trim();
  if (trimmed.length === 0) {
    return raw;
  }

  return trimmed;
}
