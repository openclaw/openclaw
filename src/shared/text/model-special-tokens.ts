/**
 * Strip model control tokens leaked into assistant text output.
 *
 * Models like GLM-5 and DeepSeek sometimes emit internal delimiter tokens
 * (e.g. `<|assistant|>`, `<|tool_call_result_begin|>`, `<｜begin▁of▁sentence｜>`)
 * in their responses. These use the universal `<|...|>` convention (ASCII or
 * full-width pipe variants) and should never reach end users.
 *
 * This is a provider bug — no upstream fix tracked yet.
 * Remove this function when upstream providers stop leaking tokens.
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;

export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  if (!MODEL_SPECIAL_TOKEN_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  return text.replace(MODEL_SPECIAL_TOKEN_RE, " ").replace(/  +/g, " ").trim();
}