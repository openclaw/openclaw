import { BoundedBuffer } from "../../../../src/shared/bounded-buffer.ts";
import type { TerminalConnection } from "./terminal-connection.ts";

const MAX_PENDING_INPUT_CHARS = 8 * 1024;

export type StartupInputBuffer = BoundedBuffer<string>;

export function createTerminalStartupInput(
  connection: Pick<TerminalConnection, "input" | "resize">,
  getSessionId: () => string | undefined,
) {
  // Per-tab decoder with stream:true so a multi-byte UTF-8 sequence split
  // across WebSocket/libterminal chunks (CJK/emoji paste before bind) cannot
  // produce U+FFFD mojibake. Keep the decoder open across session adoption;
  // only flush on true stream end (tab dispose).
  const decoder = new TextDecoder();
  // Preserve a valid startup prefix: after one drop, all later chunks stay dropped.
  const buffer = new BoundedBuffer<string>(
    MAX_PENDING_INPUT_CHARS,
    { mode: "latch" },
    (data) => data.length,
  );

  const deliver = (data: string) => {
    if (!data) {
      return;
    }
    const sessionId = getSessionId();
    if (sessionId) {
      void connection.input(sessionId, data);
    } else {
      buffer.push(data);
    }
  };

  return {
    buffer,
    onData: (bytes: Uint8Array) => {
      deliver(decoder.decode(bytes, { stream: true }));
    },
    /** Emit any incomplete trailing UTF-8 sequence held by the stream decoder. */
    flush: () => {
      deliver(decoder.decode());
    },
    onResize: ({ columns, rows }: { columns: number; rows: number }) => {
      const sessionId = getSessionId();
      if (sessionId) {
        void connection.resize(sessionId, columns, rows);
      }
    },
  };
}
