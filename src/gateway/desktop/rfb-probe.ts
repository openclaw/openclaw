import { createCipheriv } from "node:crypto";
import net from "node:net";
import { Duplex } from "node:stream";

const RFB_BANNER_BYTES = 12;
const RFB_37_MINOR = 7;
const RFB_37_BANNER = Buffer.from("RFB 003.007\n", "ascii");
const RFB_38_BANNER = Buffer.from("RFB 003.008\n", "ascii");

export type RfbProbeResult =
  | { kind: "rfb"; securityTypes: number[] }
  | { kind: "auth-rejected"; reason: string }
  | { kind: "not-rfb"; banner: string }
  | { kind: "unreachable" }
  | { kind: "timeout" };

const MAX_RFB_REASON_BYTES = 1024;
const MAX_RFB_DESKTOP_NAME_BYTES = 4096;
const RFB_SERVER_INIT_BYTES = 24;

class RfbAuthenticationRejected extends Error {
  override name = "RfbAuthenticationRejected";
}

function reverseByteBits(value: number): number {
  let input = value;
  let output = 0;
  for (let index = 0; index < 8; index += 1) {
    output = (output << 1) | (input & 1);
    input >>= 1;
  }
  return output;
}

/**
 * RFB VncAuth response. Single DES is the wire primitive.
 * rfb-preauth already imports this module, so the probe keeps its own copy.
 */
export function buildVncAuthResponse(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8);
  Buffer.from(password, "utf8").copy(key, 0, 0, 8);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = reverseByteBits(key[index] ?? 0);
  }
  // EDE with K1=K2 matches DES-ECB on OpenSSL builds that omit des-ecb.
  const cipher = createCipheriv("des-ede", Buffer.concat([key, key]), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/** Parses the fixed-width RFB ProtocolVersion banner without socket state. */
export function parseRfbVersionBanner(buffer: Buffer):
  | {
      kind: "rfb";
      minor: number;
      reply: Buffer;
    }
  | { kind: "not-rfb"; banner: string } {
  const banner = buffer.subarray(0, RFB_BANNER_BYTES).toString("ascii");
  if (buffer.length < RFB_BANNER_BYTES) {
    return { kind: "not-rfb", banner };
  }
  const match = /^RFB 003\.(\d{3})\n$/u.exec(banner);
  if (!match) {
    return { kind: "not-rfb", banner };
  }
  const minor = Number.parseInt(match[1] ?? "", 10);
  return {
    kind: "rfb",
    minor,
    reply:
      minor > RFB_37_MINOR
        ? RFB_38_BANNER
        : minor === RFB_37_MINOR
          ? RFB_37_BANNER
          : Buffer.from("RFB 003.003\n", "ascii"),
  };
}

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
    if (this.version.length < RFB_BANNER_BYTES) {
      const consumed = Math.min(RFB_BANNER_BYTES - this.version.length, chunk.length);
      this.version = Buffer.concat([this.version, chunk.subarray(0, consumed)]);
      remaining = chunk.subarray(consumed);
      if (this.version.length === RFB_BANNER_BYTES && !this.version.equals(this.versionReply)) {
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
      protocolMinor: number;
      versionReply: Buffer;
      inspectedPrefixLength: number;
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
      bannerBytes = await reader.readExactly(RFB_BANNER_BYTES);
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
      protocolMinor: version.minor,
      versionReply: version.reply,
      inspectedPrefixLength: inspectedPrefix.length,
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

function writeStream(stream: Duplex, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()));
  });
}

function readStreamExactly(stream: Duplex, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let got = 0;
    const finish = (error?: Error) => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
      stream.off("close", onEnd);
      if (error) {
        reject(error);
      }
    };
    const onData = (chunk: Buffer) => {
      chunks.push(chunk);
      got += chunk.length;
      if (got < length) {
        return;
      }
      stream.pause();
      finish();
      const all = Buffer.concat(chunks);
      const extra = all.subarray(length);
      if (extra.length > 0) {
        stream.unshift(extra);
      }
      resolve(all.subarray(0, length));
    };
    const onError = (error: Error) => {
      finish(error);
    };
    const onEnd = () => {
      finish(new SocketEndedError(Buffer.alloc(0)));
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
    stream.once("close", onEnd);
    stream.resume();
  });
}

/**
 * TigerVNC blacklists a loopback client that disconnects after the security
 * offer. A configured password has to finish VncAuth through ServerInit on
 * that same socket before the probe closes it.
 */
async function finishConfiguredVncAuth(params: {
  stream: Duplex;
  versionReply: Buffer;
  protocolMinor: number;
  prefixLength: number;
  password: string;
}): Promise<void> {
  const selection = params.protocolMinor < RFB_37_MINOR ? Buffer.alloc(0) : Buffer.from([2]);
  await writeStream(params.stream, Buffer.concat([params.versionReply, selection]));
  await readStreamExactly(params.stream, params.prefixLength);
  const challenge = await readStreamExactly(params.stream, 16);
  await writeStream(params.stream, buildVncAuthResponse(params.password, challenge));
  const status = (await readStreamExactly(params.stream, 4)).readUInt32BE(0);
  if (status !== 0) {
    let reason = "";
    if (params.protocolMinor >= RFB_37_MINOR) {
      try {
        const length = (await readStreamExactly(params.stream, 4)).readUInt32BE(0);
        if (length > 0 && length <= MAX_RFB_REASON_BYTES) {
          reason = (await readStreamExactly(params.stream, length)).toString("utf8");
        }
      } catch {
        // A peer may close as soon as it sends the failure status.
      }
    }
    throw new RfbAuthenticationRejected(reason || "VNC authentication failed");
  }
  // Shared ClientInit keeps an existing viewer attached while readiness checks the server.
  await writeStream(params.stream, Buffer.from([1]));
  const header = await readStreamExactly(params.stream, RFB_SERVER_INIT_BYTES);
  const nameLength = header.readUInt32BE(20);
  if (nameLength > MAX_RFB_DESKTOP_NAME_BYTES) {
    throw new Error(`RFB desktop name is too large (${nameLength})`);
  }
  if (nameLength > 0) {
    await readStreamExactly(params.stream, nameLength);
  }
}

/** Status-only inspection. Streaming callers retain connectRfbServer instead. */
export async function probeRfbServer(params: {
  host: "127.0.0.1";
  port: number;
  timeoutMs: number;
  signal?: AbortSignal;
  vncPassword?: string;
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
  try {
    await finishConfiguredVncAuth({
      stream: result.stream,
      versionReply: result.versionReply,
      protocolMinor: result.protocolMinor,
      prefixLength: result.inspectedPrefixLength,
      password: params.vncPassword,
    });
    return { kind: "rfb", securityTypes: result.securityTypes };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof RfbAuthenticationRejected) {
      return { kind: "auth-rejected", reason: error.message };
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
