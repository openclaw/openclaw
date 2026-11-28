/** Normalizes real inbound newline characters while preserving literal escape text. */
export function normalizeInboundTextNewlines(input: string): string {
  // Do NOT replace literal backslash-n sequences (\\n) as they may be part of
  // Windows paths like C:\Work\nxxx\README.md or user-intended escape sequences.
  return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
