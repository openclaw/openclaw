/**
 * Safe stream write utilities that handle EPIPE/EIO errors gracefully.
 *
 * When writing to stdout/stderr during process shutdown or restart,
 * the pipe may already be closed, causing EPIPE errors. These utilities
 * catch and suppress such errors to prevent crashes.
 *
 * Fixes: #5345, #4632
 */

/**
 * Check if an error is a broken pipe error (EPIPE or EIO).
 */
function isBrokenPipeError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

/**
 * Write to a stream, gracefully handling EPIPE/EIO errors.
 * Returns true if the write succeeded, false if it was suppressed due to broken pipe.
 */
export function safeWrite(stream: NodeJS.WritableStream, data: string): boolean {
  try {
    stream.write(data);
    return true;
  } catch (err) {
    if (isBrokenPipeError(err)) {
      // Pipe closed during shutdown - suppress error
      return false;
    }
    throw err;
  }
}

/**
 * Write a line to a stream, gracefully handling EPIPE/EIO errors.
 * Appends a newline if not already present.
 */
export function safeWriteLine(stream: NodeJS.WritableStream, line: string): boolean {
  const data = line.endsWith("\n") ? line : `${line}\n`;
  return safeWrite(stream, data);
}
