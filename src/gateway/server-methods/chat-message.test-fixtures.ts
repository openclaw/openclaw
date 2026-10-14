export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
export const INLINE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYoYAAAAASUVORK5CYII=";
export const OFFLOAD_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
export const TINY_JPEG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBAVFRUVFRUVFRUVFRUVFRUVFRUXFhUVFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGhAQGi0fICUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBEQACEQEDEQH/xAAXAAADAQAAAAAAAAAAAAAAAAAAAQMC/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB6AAAAP/EABQQAQAAAAAAAAAAAAAAAAAAACD/2gAIAQEAAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8Af//Z";

export function createImageAttachment(
  params: {
    content?: string;
    fileName?: string;
    mimeType?: string;
    type?: string;
  } = {},
) {
  return {
    ...(params.type ? { type: params.type } : {}),
    mimeType: params.mimeType ?? "image/png",
    ...(params.fileName ? { fileName: params.fileName } : {}),
    content: params.content ?? TINY_PNG_BASE64,
  };
}

export function createFileAttachment(
  fileName: string,
  mimeType: string,
  content: string,
  type = "file",
) {
  return {
    type,
    mimeType,
    fileName,
    content,
  };
}

export function createPngBuffer(size: number): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return buffer;
}

export function getMessage(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const message = (payload as { message?: unknown }).message;
  return message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
}

export function getMessageContent(payload: unknown): Array<Record<string, unknown>> {
  const content = getMessage(payload)?.content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

export function mockCallAt(
  mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  index: number,
): ReadonlyArray<unknown> | undefined {
  const calls = mock.mock.calls;
  const normalizedIndex = index < 0 ? calls.length + index : index;
  return calls[normalizedIndex];
}

export function responseErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
    return JSON.stringify(error);
  }
  return String(error);
}
