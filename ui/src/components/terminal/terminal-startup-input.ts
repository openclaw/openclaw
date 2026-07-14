import type { TerminalConnection } from "./terminal-connection.ts";

const MAX_PENDING_INPUT_CHARS = 8 * 1024;
const TERMINAL_INPUT_DECODER = new TextDecoder();

/** Preserves a valid startup prefix: after one drop, all later chunks stay dropped. */
export class StartupInputBuffer {
  private chunks: string[] = [];
  private charCount = 0;
  private overflowed = false;

  push(data: string): void {
    if (this.overflowed) {
      return;
    }
    if (this.charCount + data.length > MAX_PENDING_INPUT_CHARS) {
      this.overflowed = true;
      return;
    }
    this.chunks.push(data);
    this.charCount += data.length;
  }

  drain(): string[] {
    const chunks = this.chunks;
    this.chunks = [];
    this.charCount = 0;
    return chunks;
  }
}

export function createTerminalStartupInput(
  connection: Pick<TerminalConnection, "input" | "resize">,
  getSessionId: () => string | undefined,
) {
  const buffer = new StartupInputBuffer();
  return {
    buffer,
    onData: (bytes: Uint8Array) => {
      const data = TERMINAL_INPUT_DECODER.decode(bytes);
      const sessionId = getSessionId();
      if (sessionId) {
        void connection.input(sessionId, data);
      } else {
        buffer.push(data);
      }
    },
    onResize: ({ columns, rows }: { columns: number; rows: number }) => {
      const sessionId = getSessionId();
      if (sessionId) {
        void connection.resize(sessionId, columns, rows);
      }
    },
  };
}
