/** Buffer decoded diagnostic text; limits apply only to the unfinished suffix. */
export function createUpdateDiagnosticLines(maxPendingChars: number) {
  let pending = "";
  let droppingLine = false;
  return {
    /** True when this chunk starts discarding an oversized unfinished line. */
    push(text: string, onLine: (line: string) => void): boolean {
      if (droppingLine) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          return false;
        }
        text = text.slice(newline + 1);
        droppingLine = false;
      }
      const lines = `${pending}${text}`.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
      }
      if (pending.length > maxPendingChars) {
        pending = "";
        droppingLine = true;
        return true;
      }
      return false;
    },
    flush(onLine: (line: string) => void): void {
      if (pending) {
        onLine(pending);
        pending = "";
      }
    },
  };
}
