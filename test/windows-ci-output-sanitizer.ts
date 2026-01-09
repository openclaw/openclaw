import fs from "node:fs";

function sanitizeWindowsCIOutput(text: string): string {
  return text
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "?")
    .replace(/[\uD800-\uDFFF]/g, "?");
}

function decodeUtf8Text(chunk: unknown): string | null {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf-8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf-8");
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk).toString("utf-8");
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(
      chunk.buffer,
      chunk.byteOffset,
      chunk.byteLength,
    ).toString("utf-8");
  }
  return null;
}

export function installWindowsCIOutputSanitizer(): void {
  if (process.platform !== "win32") return;
  if (process.env.GITHUB_ACTIONS !== "true") return;

  const globalKey = "__clawdbotWindowsCIOutputSanitizerInstalled";
  if ((globalThis as Record<string, unknown>)[globalKey] === true) return;
  (globalThis as Record<string, unknown>)[globalKey] = true;

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    const text = decodeUtf8Text(chunk);
    if (text !== null)
      return originalStdoutWrite(sanitizeWindowsCIOutput(text), ...args);
    return originalStdoutWrite(chunk as never, ...args); // passthrough
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    const text = decodeUtf8Text(chunk);
    if (text !== null)
      return originalStderrWrite(sanitizeWindowsCIOutput(text), ...args);
    return originalStderrWrite(chunk as never, ...args); // passthrough
  }) as typeof process.stderr.write;

  const originalWriteSync = fs.writeSync.bind(fs);
  fs.writeSync = ((fd: number, data: unknown, ...args: unknown[]) => {
    if (fd === 1 || fd === 2) {
      const text = decodeUtf8Text(data);
      if (text !== null) {
        return originalWriteSync(fd, sanitizeWindowsCIOutput(text), ...args);
      }
    }
    return originalWriteSync(fd, data as never, ...(args as never[]));
  }) as typeof fs.writeSync;
}
