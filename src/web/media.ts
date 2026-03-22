// Simplified web media module (WhatsApp removed)
export type WebMediaResult = {
  data: Buffer;
  mimeType: string;
  fileName?: string;
};

export async function loadWebMedia(
  url: string,
  _options?: { maxBytes?: number; localRoots?: readonly string[] }
): Promise<WebMediaResult> {
  throw new Error("loadWebMedia: WhatsApp support has been removed");
}

export async function loadWebMediaRaw(url: string): Promise<Buffer> {
  throw new Error("loadWebMediaRaw: WhatsApp support has been removed");
}

export function getDefaultLocalRoots(): string[] {
  return [];
}

export function optimizeImageToJpeg(_buffer: Buffer): Promise<Buffer> {
  throw new Error("optimizeImageToJpeg: WhatsApp support has been removed");
}
