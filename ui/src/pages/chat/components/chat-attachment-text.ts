export function encodeTextAsDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return `data:text/plain;base64,${btoa(chunks.join(""))}`;
}
