/**
 * Mythos Protocol Codec — TypeScript Integration
 *
 * Drop-in replacement for JSON.parse() in the Gateway WebSocket hot path.
 * Integrates with src/gateway/server.impl.ts and server methods.
 *
 * Usage:
 *   import { createNativeCodec } from "../../mythos-native/protocol-codec.js";
 *
 *   const codec = createNativeCodec();
 *   if (codec) {
 *     const frame = codec.parseFrame(buffer);
 *     // ... route frame
 *   }
 *   // Fallback to existing JSON.parse() implementation
 */

import type {
  NativeProtocolCodec,
  NativeProtocolCodecInstance,
  NativeParsedFrame,
  NativeErrorPayload,
} from "./index.js";

let codecModule: NativeProtocolCodec | null = null;
let loadAttempted = false;

async function ensureCodecModule(): Promise<NativeProtocolCodec | null> {
  if (loadAttempted) return codecModule;
  loadAttempted = true;

  try {
    codecModule = (await import(
      "@openclaw/mythos-protocol-codec"
    )) as unknown as NativeProtocolCodec;
  } catch {
    codecModule = null;
  }

  return codecModule;
}

/**
 * Create a native protocol codec instance.
 * Returns null if the native module is not available.
 */
export async function createNativeCodec(
  maxPayload?: number,
): Promise<NativeProtocolCodecInstance | null> {
  const mod = await ensureCodecModule();
  if (!mod) return null;

  try {
    return new mod(maxPayload);
  } catch {
    return null;
  }
}

/**
 * Parse a WebSocket frame using the native codec.
 * Falls back to JSON.parse() if native is unavailable.
 */
export async function parseFrame(
  data: Buffer,
  codec: NativeProtocolCodecInstance | null,
): Promise<NativeParsedFrame> {
  if (codec) {
    return codec.parseFrame(data);
  }

  // Fallback to JS implementation
  try {
    const json = JSON.parse(data.toString("utf-8"));
    return {
      frameType: json.type || "",
      id: json.id,
      method: json.method,
      event: json.event,
      payloadRaw: json.params
        ? JSON.stringify(json.params)
        : json.data
          ? JSON.stringify(json.data)
          : undefined,
      valid: true,
    };
  } catch (e) {
    return {
      frameType: "",
      valid: false,
      error: `JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Check if the native codec is available.
 */
export async function isNativeCodecAvailable(): Promise<boolean> {
  const mod = await ensureCodecModule();
  return mod !== null;
}
