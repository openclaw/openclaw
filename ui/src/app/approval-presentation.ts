import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

export function compactApprovalCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return singleLine.length > 64 ? `${truncateUtf16Safe(singleLine, 61)}…` : singleLine;
}
