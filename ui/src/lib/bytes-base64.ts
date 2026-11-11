/// <reference lib="es2026.typedarrays" />

export function bytesToBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.fromBase64(value);
}
