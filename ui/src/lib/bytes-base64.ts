/// <reference lib="es2026.typedarrays" />

export function bytesToBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
