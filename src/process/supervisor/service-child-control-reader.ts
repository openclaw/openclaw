import type { Readable } from "node:stream";
import { createBoundedLineFramer } from "../bounded-line-framer.js";

const CONTROL_PENDING_LINE_LIMIT_BYTES = 256 * 1024;

export function readServiceChildControl(
  control: Readable,
  onLine: (line: string) => void,
  onOverflow: () => void,
): void {
  const frames = createBoundedLineFramer(CONTROL_PENDING_LINE_LIMIT_BYTES, "Control line overflow");
  control.on("data", (chunk: Buffer) => {
    const lines = frames.push(chunk);
    for (;;) {
      let next: IteratorResult<Buffer>;
      try {
        next = lines.next();
      } catch {
        frames.clear();
        onOverflow();
        return;
      }
      if (next.done) {
        return;
      }
      onLine(next.value.toString("utf8"));
    }
  });
}
