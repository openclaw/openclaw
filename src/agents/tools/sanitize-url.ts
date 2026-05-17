/**
 * Sanitize a URL argument (web-fetch) by stripping LLM sentinel-token leakage.
 *
 * Primary strategy: seek the first `http://` / `https://` and slice from there,
 * which already drops any sentinel prefix (`<|...|>`, `<<|"|`, leading quote).
 *
 * Hardening (2026-05-17): when no scheme is present, also strip paired
 * `<|...|>` tokens and a leading sentinel run so a no-scheme leak does not pass
 * through verbatim. Clean non-URL strings (e.g. `not-a-url`) are preserved so
 * existing downstream error paths still fire.
 */
export function sanitizeUrlInput(raw: string): string {
  if (typeof raw !== "string") {
    return raw;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  const httpsIdx = lower.indexOf("https://");
  const httpIdx = lower.indexOf("http://");
  const candidates = [httpsIdx, httpIdx].filter((i) => i >= 0);
  if (candidates.length === 0) {
    // No scheme: strip paired sentinel tokens + a token-like leading run.
    let s = trimmed.replace(/<\|[^|>]*\|>/g, "");
    const lead = s.match(/^[<|"]+/);
    if (lead && lead[0].length >= 2 && lead[0].includes("<")) {
      s = s.slice(lead[0].length);
    }
    const cleaned = s.trim();
    return cleaned.length === 0 ? trimmed : cleaned;
  }
  const start = Math.min(...candidates);
  return start === 0 ? trimmed : trimmed.slice(start);
}
