// Chat surfaces share a one-decimal compact token label, e.g. 214500 -> "214.5k".
export function formatCompactTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000) {
    // Values from 999,500-999,999 round to "1000.0" at one-decimal
    // thousands precision, which would display the nonsensical "1000k"
    // instead of rolling over to the M branch above. Re-check the
    // rounded result before formatting.
    const thousands = (tokens / 1_000).toFixed(1);
    if (Number(thousands) >= 1_000) {
      return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
    }
    return `${thousands.replace(/\.0$/, "")}k`;
  }
  return String(tokens);
}
