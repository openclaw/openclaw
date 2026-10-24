import { kMaxLength } from "node:buffer";
import {
  constants as zlibConstants,
  createDeflateRaw,
  createInflateRaw,
  deflateRawSync,
  inflateRawSync,
} from "node:zlib";
import type { WebSocket } from "ws";
import { getOrCreateWeakOwnerMap } from "../../shared/weak-owner-map.js";
import { SerializedGatewayFrame } from "../serialized-json.js";
import { gatewayReceiver } from "./ws-receiver.js";

/**
 * Peers that negotiate permessage-deflate (browsers, ws, Foundation, OkHttp) get
 * frames from the threshold up compressed; others are unaffected. No context
 * takeover in either direction keeps every message independent, which the
 * shared codec below relies on.
 */
export const GATEWAY_PER_MESSAGE_DEFLATE = {
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  threshold: 1024,
};

type ZlibCallback = (error: Error | null, result?: Buffer) => void;
type PerMessageDeflateCodec = {
  params: Record<string, unknown>;
  compress(data: Buffer | string, fin: boolean, callback: ZlibCallback): void;
  decompress(data: Buffer, fin: boolean, callback: ZlibCallback): void;
};

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);
const EMPTY = Buffer.alloc(0);
const Z_SYNC_FLUSH = zlibConstants.Z_SYNC_FLUSH;
const DEFLATE_LEVEL = 1;
const MIN_OUTPUT_CHUNK_BYTES = 1024;
const MAX_OUTPUT_CHUNK_BYTES = 64 * 1024;

// SAFETY: node:zlib's sync helpers pass ArrayBufferViews to _handle.writeSync
// and read [availOutAfter, availInAfter] from _writeState.
type NativeZlibStream = {
  readonly destroyed: boolean;
  _handle?: {
    writeSync?: (
      flush: number,
      input: Uint8Array,
      inputOffset: number,
      inputLength: number,
      output: Buffer,
      outputOffset: number,
      outputLength: number,
    ) => void;
  } | null;
  _writeState?: Uint32Array;
  reset(): void;
  close(): void;
  on(event: "error", listener: () => void): unknown;
};

/**
 * One zlib context shared by every connection on this thread and reset after each
 * message, which no context takeover makes independent. Creating and freeing a full
 * context per message fragments the native heap; ws keeps one per socket instead.
 * Returns null when Node no longer exposes the handle; callers use the one-shot API.
 */
function sharedZlib(open: () => NativeZlibStream) {
  let stream: NativeZlibStream | undefined;
  return (input: Uint8Array, maxOutputLength: number): Buffer | null => {
    if (!stream) {
      stream = open();
      // Failures surface through `destroyed`; the deferred error event needs a listener.
      stream.on("error", () => {});
    }
    const handle = stream["_handle"];
    const state = stream["_writeState"];
    if (typeof handle?.writeSync !== "function" || !(state instanceof Uint32Array)) {
      return null;
    }
    const chunkBytes = Math.min(
      MAX_OUTPUT_CHUNK_BYTES,
      Math.max(MIN_OUTPUT_CHUNK_BYTES, input.length * 2),
    );
    const parts: Buffer[] = [];
    let total = 0;
    let offset = 0;
    let pending = input.length;
    try {
      do {
        const output = Buffer.allocUnsafe(chunkBytes);
        handle.writeSync(Z_SYNC_FLUSH, input, offset, pending, output, 0, chunkBytes);
        if (stream.destroyed) {
          throw new Error("zlib stream failed");
        }
        const produced = chunkBytes - state[0]!;
        total += produced;
        if (total > maxOutputLength) {
          throw new RangeError("Max payload size exceeded");
        }
        parts.push(output.subarray(0, produced));
        offset += pending - state[1]!;
        pending = state[1]!;
      } while (state[0] === 0);
      stream.reset();
    } catch (error) {
      stream.close();
      stream = undefined;
      throw error;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, total);
  };
}

const inflateShared = sharedZlib(() => createInflateRaw());
const deflateShared = new Map<number, ReturnType<typeof sharedZlib>>();
const deflatedSegments = new WeakMap<Uint8Array, Map<number, Buffer>>();

/** Register immutable worker output, including its sync-flush trailer. */
export function registerDeflatedSegment(bytes: Uint8Array, deflated: Uint8Array): void {
  if (bytes.byteLength < GATEWAY_PER_MESSAGE_DEFLATE.threshold) {
    return;
  }
  const windows = getOrCreateWeakOwnerMap(deflatedSegments, bytes);
  windows.set(15, Buffer.from(deflated.buffer, deflated.byteOffset, deflated.byteLength));
}

function isPerMessageDeflateCodec(value: unknown): value is PerMessageDeflateCodec {
  return (
    typeof value === "object" &&
    value !== null &&
    "compress" in value &&
    typeof value.compress === "function" &&
    "decompress" in value &&
    typeof value.decompress === "function" &&
    "params" in value &&
    typeof value.params === "object" &&
    value.params !== null
  );
}

/**
 * Replaces ws's streaming zlib path on a negotiated connection with synchronous
 * compression and shared segment reuse. ws's streams need a threadpool round trip, and so a
 * busy event-loop turn, per call and per 16 KiB of output while the socket
 * stops parsing or sending; inline level-1 zlib costs about 3 ms per MiB
 * deflated and less inflated. Returns undefined when the peer negotiated
 * compression but the ws extension no longer has the expected shape; ws then
 * keeps its slower path.
 */
export function installGatewayDeflateCodec(socket: WebSocket):
  | {
      acceptsDeflatedSegments: boolean;
      compress: (
        frame: Buffer | SerializedGatewayFrame,
      ) => Buffer | SerializedGatewayFrame | undefined;
    }
  | undefined {
  // SAFETY: ws owns the negotiated extension; validate its shape before replacing methods.
  const codec = (socket as WebSocket & { _extensions?: Record<string, unknown> })["_extensions"]?.[
    "permessage-deflate"
  ];
  if (codec === undefined) {
    return {
      acceptsDeflatedSegments: false,
      compress: () => undefined,
    };
  }
  const receiver = gatewayReceiver(socket);
  if (
    !receiver ||
    !isPerMessageDeflateCodec(codec) ||
    codec.params.client_no_context_takeover !== true ||
    codec.params.server_no_context_takeover !== true
  ) {
    return undefined;
  }
  const streamDecompress = codec.decompress.bind(codec);
  // Never call back synchronously: ws would re-enter its frame loop. Admitted
  // operators parse a whole burst in one turn; other receivers yield one turn
  // per message, matching uncompressed delivery.
  const deliver = (callback: ZlibCallback, result: Buffer) => {
    if (receiver["_allowSynchronousEvents"] === true) {
      process.nextTick(callback, null, result);
    } else {
      setImmediate(callback, null, result);
    }
  };

  let inbound: Buffer[] = [];
  codec.decompress = (data, fin, callback) => {
    // Empty continuation frames must not consume memory outside the byte limit.
    if (data.length > 0) {
      inbound.push(data);
    }
    if (!fin) {
      deliver(callback, EMPTY);
      return;
    }
    const input = Buffer.concat([...inbound, TRAILER]);
    inbound = [];
    // ws treats 0 as unlimited; the limit bounds the inflated size.
    const maxOutputLength = receiver["_maxPayload"] || kMaxLength;
    let output: Buffer;
    try {
      output =
        inflateShared(input, maxOutputLength) ??
        inflateRawSync(input, { finishFlush: Z_SYNC_FLUSH, maxOutputLength });
    } catch {
      // ws's own path reproduces its canonical error and close code (1007/1009).
      streamDecompress(input.subarray(0, -TRAILER.length), true, callback);
      return;
    }
    deliver(callback, output);
  };

  // Peers may cap the server window; farther back-references would break their inflater.
  const windowBits =
    typeof codec.params.server_max_window_bits === "number"
      ? codec.params.server_max_window_bits
      : zlibConstants.Z_DEFAULT_WINDOWBITS;
  const deflateOptions = { finishFlush: Z_SYNC_FLUSH, level: DEFLATE_LEVEL, windowBits };
  let deflate = deflateShared.get(windowBits);
  if (!deflate) {
    deflate = sharedZlib(() => createDeflateRaw(deflateOptions));
    deflateShared.set(windowBits, deflate);
  }
  const compressPiece = (input: Uint8Array): Buffer =>
    deflate(input, kMaxLength) ?? deflateRawSync(input, deflateOptions);
  const compress = (
    frame: Buffer | SerializedGatewayFrame,
  ): Buffer | SerializedGatewayFrame | undefined => {
    if (frame.byteLength < GATEWAY_PER_MESSAGE_DEFLATE.threshold) {
      return undefined;
    }
    const segments = frame instanceof SerializedGatewayFrame ? frame.segments : undefined;
    if (segments?.some((bytes) => bytes.byteLength >= GATEWAY_PER_MESSAGE_DEFLATE.threshold)) {
      const pieces: Buffer[] = [];
      let small: Uint8Array[] = [];
      const flushSmall = () => {
        if (small.length > 0) {
          const input = small.length === 1 ? small[0]! : Buffer.concat(small);
          pieces.push(compressPiece(input));
          small = [];
        }
      };
      for (const bytes of segments) {
        if (bytes.byteLength < GATEWAY_PER_MESSAGE_DEFLATE.threshold) {
          small.push(bytes);
          continue;
        }
        flushSmall();
        const windows = getOrCreateWeakOwnerMap(deflatedSegments, bytes);
        let piece = windows.get(windowBits);
        if (!piece) {
          // Avoid retaining pooled slabs for small copies; keep Node's native large-copy path.
          const compressed = compressPiece(bytes);
          if (compressed.length < Buffer.poolSize >>> 1) {
            piece = Buffer.allocUnsafeSlow(compressed.length);
            compressed.copy(piece);
          } else {
            piece = Buffer.from(compressed);
          }
          windows.set(windowBits, piece);
        }
        pieces.push(piece);
      }
      flushSmall();
      // Independent raw streams concatenate at sync-flush boundaries; keep interior trailers.
      const last = pieces.length - 1;
      pieces[last] = pieces[last]!.subarray(0, -TRAILER.length);
      return new SerializedGatewayFrame(pieces);
    }
    // Z_SYNC_FLUSH ends with the empty block that permessage-deflate strips.
    return compressPiece(
      frame instanceof SerializedGatewayFrame ? frame.toBuffer() : frame,
    ).subarray(0, -TRAILER.length);
  };
  return {
    acceptsDeflatedSegments: windowBits === zlibConstants.Z_DEFAULT_WINDOWBITS,
    compress,
  };
}
