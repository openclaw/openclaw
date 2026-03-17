import type { OpenClawConfig } from "../config/config.js";

export type GeneratedImageAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName?: string;
  revisedPrompt?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationRequest = {
  provider: string;
  model: string;
  prompt: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  count?: number;
  size?: string;
};

export type ImageGenerationResult = {
  images: GeneratedImageAsset[];
  model?: string;
  metadata?: Record<string, unknown>;
};

export type ImageGenerationProvider = {
  id: string;
  aliases?: string[];
  label?: string;
  supportedSizes?: string[];
  generateImage: (req: ImageGenerationRequest) => Promise<ImageGenerationResult>;
};
