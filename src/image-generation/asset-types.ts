/** Non-empty binary image asset returned by an image-generation provider. */
export type GeneratedImageAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationSourceImage = Omit<GeneratedImageAsset, "revisedPrompt">;
