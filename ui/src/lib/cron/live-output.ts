import type { CronLiveOutputResult } from "@openclaw/gateway-protocol";

/** Bounds the displayed text; the Gateway tail is bounded separately by bytes. */
const LIVE_OUTPUT_MAX_LINES = 2000;
/** Mirrors the Gateway tail cap, so output without newlines is bounded too. */
const LIVE_OUTPUT_MAX_CHARS = 256 * 1024;

export type LiveOutputView = { text: string; truncated: boolean };

/** Index after the (N + 1)th newline counted from the end, or 0 when the text is short enough. */
function lineLimitStart(text: string): number {
  let cut = text.length;
  for (let seen = 0; seen <= LIVE_OUTPUT_MAX_LINES; seen += 1) {
    cut = cut > 0 ? text.lastIndexOf("\n", cut - 1) : -1;
    if (cut < 0) {
      return 0;
    }
  }
  return cut + 1;
}

/** Folds one `cron.liveOutput` read into what the panel shows, dropping the oldest output. */
export function applyLiveOutput(
  view: LiveOutputView,
  result: Pick<CronLiveOutputResult, "text" | "reset" | "truncated">,
): LiveOutputView {
  const text = result.reset ? result.text : view.text + result.text;
  const truncated = result.reset ? result.truncated === true : view.truncated;
  let start = Math.max(lineLimitStart(text), text.length - LIVE_OUTPUT_MAX_CHARS);
  if (start > 0 && start < text.length && /[\udc00-\udfff]/.test(text.charAt(start))) {
    // Never start inside a surrogate pair.
    start += 1;
  }
  return start > 0 ? { text: text.slice(start), truncated: true } : { text, truncated };
}
