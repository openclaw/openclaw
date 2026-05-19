/**
 * Sanitize a shell command before execution.
 *
 * Strips LLM special tokens (e.g. `<|...|>`, `<|<|"`, `<\|"|`, the
 * double-less-than variants `<<|"|`, `<<|`, `<<`, `<<<`, and the args-start
 * variants `<<|"|>cmd`, `<<|"<<|<|"cmd -|<|"cmd ...` observed 2026-05-19
 * 13:38) that some smaller models (Gemma 4, etc.) occasionally leak into
 * tool call arguments. These tokens cause bash to fail with syntax errors,
 * which in turn forces the model to hallucinate answers it could not
 * retrieve.
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

  // 3b) 중간 sentinel 클러스터 제거 (2026-05-19 13:38 jsonl L252 변형).
  //    누설이 명령 중간에 끼어 `ls -|<|"ls -l ...` 처럼 진짜 텍스트 조각과
  //    엉키는 경우, 단계 4a 는 `<|"` 만 떼어내 선행 `|` 가 남아
  //    `ls -|ls -l`(깨진 파이프)이 된다. `[<>|"]` 가 2자 이상 연속이고
  //    `|` 와 `<` 를 모두 포함하는 run(=누설 시그니처) 은 통째로 제거한다.
  //    순수 `||`(bash OR), `<<`(heredoc), `>>`(append), `"|"`(따옴표 안
  //    파이프 문자) 는 `<` 또는 `|` 조건에 걸리지 않아 보존된다.
  s = s.replace(/[<>|"]{2,}/g, (m) => (m.includes("|") && m.includes("<") ? "" : m));

  // 4) 토큰 잔재 / 누설 패턴 제거
  //    관찰: `<|"|`, `<|<|"`, `<|<|`, `|>`, `<|`
  //    명령 시작·중간 어디든 가능. 단 `|` 단독은 파이프이므로 절대 건드리지 않음.
  s = s.replace(/<\|"?\|?/g, ""); // <|" | <|" | <|
  s = s.replace(/\|>/g, ""); // |>

  // 4d) raw-anchored 선행 잔재 제거 (2026-05-19 13:38 jsonl L254/256/258).
  //    원본이 2자 이상 sentinel 클러스터(>= `<` 또는 `|` 포함, `>` 도 인식)
  //    로 시작한 경우, 단계 1 의 `<|...|>` 제거가 클러스터 안쪽만 떼어내
  //    선행에 고아 `<`/`|` 1자가 남을 수 있다(`<<|"|>` → 단계1 후 `<`).
  //    단계 2 는 길이 >= 2 조건 때문에 이 1자 고아를 못 잡는다. 원본 기준
  //    으로 누설 시작이 확정된 경우에만 남은 선행 sentinel run 을 제거 →
  //    `<ls -ls -l ...`(잘못된 입력 redirect) 를 `ls -ls -l ...` 로 복원.
  //    단독 선행 `"`(unmatched quote)·`<x>`·단일 `<` 는 raw 선행 run 이
  //    1자라 발동하지 않으므로 보존된다.
  const rawLead = raw.match(/^[<>|"]+/);
  if (rawLead && rawLead[0].length >= 2 && /[<|]/.test(rawLead[0])) {
    s = s.replace(/^[<>|"]+/, "");
  }

  // 5) 결과 검증
  const trimmed = s.trim();

  // (5a) 원본 자체가 sentinel(`<`,`>`,`|`,`"`,공백)만으로 구성된 경우:
  //      - 길이 1 (단독 `<`, `>`, `|`, `"`) → 정당한 redirect/pipe 단편일 수 있어 보존
  //      - 길이 2+ (`<<`, `<|>`, `<<|"|>` 등) → 명령으로 의미 없고 bash syntax
  //        error 만 유발하므로 "" 반환. 빈 문자열이면 bash 가 no-op 으로 처리되어
  //        모델이 환각 답변을 만들지 않는다 (incident 2026-05-19 황선아 환각).
  //      raw 기준으로 판정하는 이유: `<<|"|>` 는 룰 1~4 처리 후 `<` 잔재만 남아
  //      단독 `<` 입력과 sanitize 결과가 같아진다. 둘을 구분하려면 원본을 본다.
  //      정당한 bash 입력 (`cat <file`, `echo "x"`, `a | b`) 은 영문/숫자가
  //      있어 이 정규식에 매칭되지 않으므로 영향 없음.
  const rawTrimmed = raw.trim();
  if (/^[<>|"\s]+$/.test(rawTrimmed)) {
    return rawTrimmed.length === 1 ? rawTrimmed : "";
  }

  // (5b) 실내용이 있는 명령: sanitize 결과 사용. 비었으면 원본 반환(오류 추적용)
  if (trimmed.length === 0) {
    return raw;
  }

  return trimmed;
}
