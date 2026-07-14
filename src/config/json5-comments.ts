const STRIDE = 1;

const skipQuotedString = (raw: string, start: number, quote: string): number => {
  let pos = start + STRIDE;
  while (pos < raw.length && raw[pos] !== quote) {
    if (raw[pos] === "\\") {
      pos += STRIDE;
    }
    pos += STRIDE;
  }
  return pos;
};

/** Detects `//` or `/*` tokens outside JSON5 string literals. */
const hasJSON5Comments = (raw: string): boolean => {
  for (let idx = 0; idx < raw.length; idx += STRIDE) {
    const char = raw[idx];
    if (char === '"' || char === "'" || char === "`") {
      idx = skipQuotedString(raw, idx, char);
    } else if (char === "/" && idx + STRIDE < raw.length) {
      const next = raw[idx + STRIDE];
      if (next === "/" || next === "*") {
        return true;
      }
    }
  }
  return false;
};

export const checkCommentLossWarning = (
  raw: string | null | undefined,
  filePath: string,
  warn?: (msg: string) => void,
  skipOutputLogs?: boolean,
): string | undefined => {
  if (skipOutputLogs || typeof raw !== "string" || !hasJSON5Comments(raw)) {
    return undefined;
  }
  const msg =
    `Config write will strip JSON5 comments from ${filePath}. ` +
    "Use a separate tool to re-add documentation comments after modifications.";
  warn?.(msg);
  return msg;
};
