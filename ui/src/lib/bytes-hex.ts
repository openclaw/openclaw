/// <reference lib="es2026.typedarrays" />

export function bytesToHex(bytes: Uint8Array): string {
  return bytes.toHex();
}
