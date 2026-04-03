export type SafeStreamWriterOptions = {
  beforeWrite?: () => void;
  onBrokenPipe?: (err: NodeJS.ErrnoException, stream: NodeJS.WriteStream) => void;
};

export type SafeStreamWriter = {
  write: (stream: NodeJS.WriteStream, text: string) => boolean;
  writeLine: (stream: NodeJS.WriteStream, text: string) => boolean;
  writeAsync: (stream: NodeJS.WriteStream, text: string) => Promise<boolean>;
  writeLineAsync: (stream: NodeJS.WriteStream, text: string) => Promise<boolean>;
  reset: () => void;
  isClosed: () => boolean;
};

function isBrokenPipeError(err: unknown): err is NodeJS.ErrnoException {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPIPE" || code === "EIO";
}

export function createSafeStreamWriter(options: SafeStreamWriterOptions = {}): SafeStreamWriter {
  let closed = false;
  let notified = false;

  const noteBrokenPipe = (err: NodeJS.ErrnoException, stream: NodeJS.WriteStream) => {
    if (notified) {
      return;
    }
    notified = true;
    options.onBrokenPipe?.(err, stream);
  };

  const handleError = (err: unknown, stream: NodeJS.WriteStream): boolean => {
    if (!isBrokenPipeError(err)) {
      throw err;
    }
    closed = true;
    noteBrokenPipe(err, stream);
    return false;
  };

  const write = (stream: NodeJS.WriteStream, text: string): boolean => {
    if (closed) {
      return false;
    }
    try {
      options.beforeWrite?.();
    } catch (err) {
      return handleError(err, process.stderr);
    }
    try {
      stream.write(text);
      return !closed;
    } catch (err) {
      return handleError(err, stream);
    }
  };

  const writeLine = (stream: NodeJS.WriteStream, text: string): boolean =>
    write(stream, `${text}\n`);

  // Async variant: awaits the stream's `drain` event when the write buffer is
  // full (stream.write returns false). This prevents unbounded heap growth when
  // stdout is backed up (e.g. piped to `less`, Ctrl+S paused, slow redirect).
  const writeAsync = async (stream: NodeJS.WriteStream, text: string): Promise<boolean> => {
    if (closed) {
      return false;
    }
    try {
      options.beforeWrite?.();
    } catch (err) {
      return handleError(err, process.stderr);
    }
    try {
      if (!stream.write(text)) {
        // Buffer full — pause until the stream drains before accepting more data.
        await new Promise<void>((resolve) => stream.once("drain", resolve));
      }
      return !closed;
    } catch (err) {
      return handleError(err, stream);
    }
  };

  const writeLineAsync = (stream: NodeJS.WriteStream, text: string): Promise<boolean> =>
    writeAsync(stream, `${text}\n`);

  return {
    write,
    writeLine,
    writeAsync,
    writeLineAsync,
    reset: () => {
      closed = false;
      notified = false;
    },
    isClosed: () => closed,
  };
}
