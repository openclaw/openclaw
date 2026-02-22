let activeStream: NodeJS.WriteStream | null = null;

function safeIsStreamTTY(stream: NodeJS.WriteStream | null | undefined): boolean {
  try {
    return Boolean(stream?.isTTY);
  } catch {
    return false;
  }
}

export function registerActiveProgressLine(stream: NodeJS.WriteStream): void {
  if (!safeIsStreamTTY(stream)) {
    return;
  }
  activeStream = stream;
}

export function clearActiveProgressLine(): void {
  if (!safeIsStreamTTY(activeStream)) {
    return;
  }
  try {
    activeStream!.write("\r\x1b[2K");
  } catch {
    // ignore write errors (e.g. EPIPE when running under process wrapper)
  }
}

export function unregisterActiveProgressLine(stream?: NodeJS.WriteStream): void {
  if (!activeStream) {
    return;
  }
  if (stream && activeStream !== stream) {
    return;
  }
  activeStream = null;
}
