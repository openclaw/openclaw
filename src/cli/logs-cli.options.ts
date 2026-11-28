import { parseOptionalPositiveInteger } from "./parse-positive-integer.js";

export function parseLogsPositiveInt(value: unknown, fallback: number, flag: string): number {
  return parseOptionalPositiveInteger(value, flag, ".") ?? fallback;
}

export function formatLogTruncationNotice({
  moreLines,
  moreBytes,
  journal,
}: {
  moreLines: boolean;
  moreBytes: boolean;
  journal: boolean;
}): string {
  if (moreLines && moreBytes) {
    return "Log tail truncated (increase --limit or --max-bytes).";
  }
  const source = journal
    ? "check the systemd journal on this host"
    : "open the log file on the Gateway host";
  if (moreLines || moreBytes) {
    return `Log tail truncated. Try increasing ${moreLines ? "--limit" : "--max-bytes"}, or ${source}.`;
  }
  return `Log tail truncated. For earlier entries, ${source}.`;
}
