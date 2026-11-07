import type { CommandOptions } from "../process/exec.js";

/** Git uses carriage returns and can split a progress line across stderr chunks. */
export function createGitTransferProgress(report: (message: string) => void): {
  onOutputChunk: NonNullable<CommandOptions["onOutputChunk"]>;
  flush: () => void;
} {
  let pending = "";
  const emit = (line: string) => {
    // Remote stderr is untrusted. Only publish Git's numeric transfer vocabulary.
    const match =
      /^(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas):\s+(\d+(?:%\s+\(\d+\/\d+\))?(?:,\s+\d+(?:\.\d+)?\s+(?:bytes|[KMGT]iB)(?:\s+\|\s+\d+(?:\.\d+)?\s+(?:bytes|[KMGT]iB)\/s)?)?(?:, done\.)?)\s*$/u.exec(
        line,
      );
    if (match) {
      report(`${match[1]}: ${match[2]}`);
    }
  };
  return {
    onOutputChunk(chunk, stream) {
      if (stream !== "stderr") {
        return;
      }
      const lines = (pending + chunk.toString("utf8")).split(/[\r\n]/u);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        emit(line);
      }
      // Genuine progress lines are short; do not retain arbitrary remote output.
      pending = pending.slice(-1024);
    },
    flush() {
      emit(pending);
      pending = "";
    },
  };
}
