import net from "node:net";
import { Duplex } from "node:stream";
import {
  attachRfbPreauthStream,
  negotiateServer,
  parseRfbVersionBanner,
  RfbAuthenticationRejectedError,
  RFB_37_MINOR,
  RFB_VERSION_BYTES,
  type RfbPreauthPeer,
} from "./rfb-preauth.js";

export type RfbProbeResult =
  | { kind: "rfb"; securityTypes: number[] }
  | { kind: "auth-rejected"; reason: string }
  | { kind: "not-rfb"; banner: string }
  | { kind: "unreachable" }
  | { kind: "timeout" };

const MAX_RFB_DESKTOP_NAME_BYTES = 4096;
const RFB_SERVER_INIT_BYTES = 24;

export { parseRfbVersionBanner };

class SocketEndedError extends Error {
  constructor(readonly buffered: Buffer) {
    super("RFB server closed the handshake early");
  }
}

class SocketTimeoutError extends Error {}

function createSocketReader(socket: net.Socket) {
  let failure: Error | undefined;
  let resumeRead: (() => void) | undefined;
  const wake = () => resumeRead?.();
  const onEnd = () => {
    failure ??= new SocketEndedError(socket.read() ?? Buffer.alloc(0));
    wake();
  };
  const onError = (error: Error) => {
    failure = error;
    wake();
  };
  // Readable mode leaves unread bytes in the socket's bounded buffer for handoff.
  socket.on("readable", wake);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  socket.once("error", onError);
  return {
    async readExactly(length: number): Promise<Buffer> {
      for (;;) {
        const value: Buffer | null = socket.read(length);
        if (value) {
          if (value.length !== length) {
            throw new SocketEndedError(value);
          }
          return value;
        }
        if (failure) {
          throw failure;
        }
        await new Promise<void>((resolve) => {
          resumeRead = resolve;
        });
        resumeRead = undefined;
      }
    },
    detach(): void {
      socket.pause();
      socket.off("readable", wake);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
    },
  };
}

/** Replays the inspected prefix while keeping authentication on the same TCP connection. */
class ConnectedRfbStream extends Duplex {
  private version = Buffer.alloc(0);

  constructor(
    private readonly socket: net.Socket,
    private readonly versionReply: Buffer,
  ) {
    super({ allowHalfOpen: false });
    // The caller may still be reading credentials when the peer closes. Retain an
    // error listener through that handoff; the transport checks destroyed/errored.
    this.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (!this.push(chunk)) {
        socket.pause();
      }
    });
    socket.once("end", () => {
      this.push(null);
      // Stop client writes at native EOF even if the readable tail is still paused.
      this.end();
    });
    socket.once("close", () => {
      // Normal EOF may leave unread bytes in this Duplex while its consumer is paused.
      // Let them drain before auto-destroy; only a premature close discards the stream.
      if (!socket.readableEnded) {
        this.destroy(new Error("RFB peer closed before ending the stream"));
      }
    });
    socket.once("error", (error) => this.destroy(error));
  }

  override _read(): void {
    this.socket.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    let remaining = chunk;
    if (this.version.length < RFB_VERSION_BYTES) {
      const consumed = Math.min(RFB_VERSION_BYTES - this.version.length, chunk.length);
      this.version = Buffer.concat([this.version, chunk.subarray(0, consumed)]);
      remaining = chunk.subarray(consumed);
      if (this.version.length === RFB_VERSION_BYTES && !this.version.equals(this.versionReply)) {
        callback(new Error("RFB client changed the inspected protocol version"));
        return;
      }
    }
    if (remaining.length) {
      this.socket.write(remaining, callback);
    } else {
      callback();
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.socket.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.socket.destroy();
    callback(error);
  }
}

/** Inspects an RFB offer and retains that connection for its authenticated stream. */
export async function connectRfbServer(params: {
  host: "127.0.0.1";
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<
  | {
      kind: "rfb";
      securityTypes: number[];
      stream: Duplex;
    }
  | Exclude<RfbProbeResult, { kind: "rfb" }>
> {
  params.signal?.throwIfAborted();
  // ConnectedRfbStream alone drains and ends writes; native auto-finalization
  // would race the wrapper's queued writes when FIN arrives with unread output.
  const socket = net.createConnection({
    port: params.port,
    host: params.host,
    allowHalfOpen: true,
  });
  const deadline = setTimeout(() => {
    socket.destroy(new SocketTimeoutError("RFB handshake timed out"));
  }, params.timeoutMs);
  deadline.unref();
  const reader = createSocketReader(socket);
  let retained = false;
  const onAbort = () =>
    socket.destroy(
      params.signal?.reason instanceof Error
        ? params.signal.reason
        : new Error("RFB connection aborted"),
    );
  params.signal?.addEventListener("abort", onAbort, { once: true });
  socket.once("close", () => params.signal?.removeEventListener("abort", onAbort));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    let bannerBytes: Buffer;
    try {
      bannerBytes = await reader.readExactly(RFB_VERSION_BYTES);
    } catch (error) {
      params.signal?.throwIfAborted();
      if (error instanceof SocketEndedError) {
        return { kind: "not-rfb", banner: error.buffered.toString("ascii") };
      }
      throw error;
    }
    const version = parseRfbVersionBanner(bannerBytes);
    if (version.kind === "not-rfb") {
      return version;
    }
    socket.write(version.reply);

    let securityBuffer: Buffer;
    let securityTypes: number[];
    if (version.minor < RFB_37_MINOR) {
      securityBuffer = await reader.readExactly(4);
      const securityType = securityBuffer.readUInt32BE(0);
      securityTypes = securityType === 0 ? [] : [securityType];
    } else {
      securityBuffer = await reader.readExactly(1);
      const count = securityBuffer.readUInt8(0);
      const offered = count > 0 ? await reader.readExactly(count) : Buffer.alloc(0);
      securityBuffer = Buffer.concat([securityBuffer, offered]);
      securityTypes = [...offered];
    }
    params.signal?.throwIfAborted();
    reader.detach();
    const stream = new ConnectedRfbStream(socket, version.reply);
    // The Gateway still receives the original RFB wire contract. Only its version
    // reply is consumed locally, since inspection already sent it to this peer.
    const inspectedPrefix = Buffer.concat([bannerBytes, securityBuffer]);
    socket.unshift(inspectedPrefix);
    retained = true;
    return {
      kind: "rfb",
      securityTypes,
      stream,
    };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof SocketTimeoutError) {
      return { kind: "timeout" };
    }
    return { kind: "unreachable" };
  } finally {
    clearTimeout(deadline);
    if (!retained) {
      reader.detach();
      socket.destroy();
    }
  }
}

/**
 * TigerVNC blacklists a loopback client that disconnects after the security
 * offer. A configured password finishes upstream VncAuth on that same socket,
 * then ClientInit and ServerInit, before the probe closes it.
 */
async function finishConfiguredVncAuth(params: {
  stream: Duplex;
  password: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<void> {
  const attached = attachRfbPreauthStream(params.stream);
  const signal = params.signal ?? new AbortController().signal;
  // The VNC response is the credential. Revocation fails before that write is sent.
  const peer: RfbPreauthPeer = {
    readExactly: (length, requestSignal) => attached.peer.readExactly(length, requestSignal),
    async write(bytes, requestSignal) {
      params.assertCurrent?.();
      await attached.peer.write(bytes, requestSignal);
    },
  };
  try {
    await negotiateServer({
      peer,
      preauth: { auth: "vnc-password", credentials: { password: params.password } },
      signal,
    });
    // Shared ClientInit keeps an existing viewer attached while readiness checks the server.
    await peer.write(Buffer.from([1]), signal);
    const header = await peer.readExactly(RFB_SERVER_INIT_BYTES, signal);
    const nameLength = header.readUInt32BE(20);
    if (nameLength > MAX_RFB_DESKTOP_NAME_BYTES) {
      throw new Error(`RFB desktop name is too large (${nameLength})`);
    }
    if (nameLength > 0) {
      await peer.readExactly(nameLength, signal);
    }
  } finally {
    attached.dispose();
  }
}

/** Status-only inspection. Streaming callers retain connectRfbServer instead. */
export async function probeRfbServer(params: {
  host: "127.0.0.1";
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
  vncPassword?: string;
  assertCurrent?: () => void;
}): Promise<RfbProbeResult> {
  const result = await connectRfbServer(params);
  if (result.kind !== "rfb") {
    return result;
  }
  if (!params.vncPassword || classifyRfbSecurity(result.securityTypes) !== "vnc-password") {
    result.stream.destroy();
    return { kind: "rfb", securityTypes: result.securityTypes };
  }
  const deadline = setTimeout(() => {
    result.stream.destroy(new SocketTimeoutError("RFB handshake timed out"));
  }, params.timeoutMs);
  deadline.unref();
  let authorityRevoked = false;
  const assertCurrent = () => {
    try {
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
    } catch (error) {
      authorityRevoked = true;
      throw error;
    }
  };
  try {
    await finishConfiguredVncAuth({
      stream: result.stream,
      password: params.vncPassword,
      signal: params.signal,
      assertCurrent,
    });
    return { kind: "rfb", securityTypes: result.securityTypes };
  } catch (error) {
    if (authorityRevoked) {
      throw error;
    }
    params.signal?.throwIfAborted();
    if (error instanceof RfbAuthenticationRejectedError) {
      return { kind: "auth-rejected", reason: error.reason || "VNC authentication failed" };
    }
    if (error instanceof SocketTimeoutError) {
      return { kind: "timeout" };
    }
    return { kind: "unreachable" };
  } finally {
    clearTimeout(deadline);
    result.stream.destroy();
  }
}

/** Maps standard RFB security numbers into the credential UX supported by OpenClaw. */
export function classifyRfbSecurity(
  securityTypes: readonly number[],
): "none" | "vnc-password" | "ard-account" | "unsupported" {
  // noVNC selects the first security type it supports in the server's order.
  // Mirror that choice so the Gateway credential flow cannot disagree with the
  // browser (macOS advertises ARD before its VncAuth compatibility option).
  for (const securityType of securityTypes) {
    if (securityType === 1) {
      return "none";
    }
    if (securityType === 2) {
      return "vnc-password";
    }
    if (securityType === 30) {
      return "ard-account";
    }
    if ([6, 16, 19, 22, 113].includes(securityType)) {
      // noVNC supports these schemes and stops here, but OpenClaw has no matching credential UX.
      // Scanning onward would make the probe choose a route the browser never selects.
      return "unsupported";
    }
  }
  return "unsupported";
}
