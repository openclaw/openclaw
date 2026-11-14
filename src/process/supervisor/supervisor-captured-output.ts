import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export const DEFAULT_MAX_CAPTURED_OUTPUT_CHARS = 1024 * 1024;

/** Keep the newest captured output within its cap, marking any truncation. */
export function appendCapturedOutput(
  current: string,
  chunk: string,
  stream: "stdout" | "stderr",
  maxChars: number,
) {
  const next = current + chunk;
  if (next.length <= maxChars) {
    return next;
  }
  const marker = `[openclaw: captured ${stream} truncated to last ${maxChars} chars]\n`;
  const tailChars = Math.max(0, maxChars - marker.length);
  return `${marker}${sliceUtf16Safe(next, -tailChars)}`;
}
