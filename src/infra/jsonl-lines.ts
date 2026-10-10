import { Transform, type Readable, type TransformCallback } from "node:stream";

/** Frame JSONL on LF bytes only; Unicode separators are legal inside JSON strings. */
export function createJsonlLineReader(input: Readable): Transform & { close(): void } {
  class JsonlLineReader extends Transform {
    private fragments: Buffer[] = [];
    private bytes = 0;

    constructor() {
      super({ readableObjectMode: true });
    }

    private emitLine(tail: Buffer) {
      const line = this.fragments.length
        ? Buffer.concat([...this.fragments, tail], this.bytes + tail.length)
        : tail;
      this.fragments = [];
      this.bytes = 0;
      // Decode only complete records so UTF-8 survives arbitrary chunk boundaries.
      const text = line.toString("utf8");
      this.push(text.endsWith("\r") ? text.slice(0, -1) : text);
    }

    override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      let offset = 0;
      for (;;) {
        const newline = chunk.indexOf(0x0a, offset);
        if (newline < 0) {
          const tail = chunk.subarray(offset);
          if (tail.length) {
            this.fragments.push(tail);
            this.bytes += tail.length;
          }
          break;
        }
        this.emitLine(chunk.subarray(offset, newline));
        offset = newline + 1;
      }
      done();
    }

    override _flush(done: TransformCallback) {
      if (this.bytes) {
        this.emitLine(Buffer.alloc(0));
      }
      done();
    }

    override _destroy(error: Error | null, done: (error?: Error | null) => void) {
      this.fragments = [];
      this.bytes = 0;
      done(error);
    }

    close() {
      this.destroy();
    }
  }

  const lines = new JsonlLineReader();
  const onError = (error: Error) => lines.destroy(error);
  input.on("error", onError);
  lines.once("close", () => {
    input.unpipe(lines);
    input.pause();
    input.off("error", onError);
  });
  input.pipe(lines);
  return lines;
}
