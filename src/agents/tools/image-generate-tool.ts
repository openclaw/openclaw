/**
 * Image Generation Tool
 *
 * Generates images from text prompts using Gemini 3 Pro (image preview).
 * Returns a MEDIA: path that can be attached to messages.
 *
 * Supported providers:
 * - Gemini (Google): gemini-3-pro-image-preview via generativelanguage.googleapis.com
 *
 * Future providers:
 * - OpenAI (gpt-image-1 / dall-e-3)
 * - xAI (grok-imagine-video for video, when credits available)
 */

import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { resolveConfigDir } from "../../utils.js";
import { readStringParam, readNumberParam } from "./common.js";

// ── Schema ──────────────────────────────────────────────────────────

const ImageGenerateSchema = Type.Object({
  prompt: Type.String({
    description:
      "Text description of the image to generate. Be specific and descriptive for best results. Example: 'A serene mountain landscape at sunset with a lake in the foreground reflecting orange and purple clouds'",
  }),
  style: Type.Optional(
    Type.String({
      description:
        "Optional style hint. Examples: 'photorealistic', 'watercolor', 'pixel-art', 'oil-painting', 'digital-art', 'anime', 'sketch'. Appended to the prompt.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        "Optional aspect ratio. Examples: '1:1' (square), '16:9' (widescreen), '9:16' (portrait), '4:3'. Default: model decides.",
    }),
  ),
  outputPath: Type.Optional(
    Type.String({
      description:
        "Optional file path to save the generated image. If not specified, saves to the media directory with an auto-generated name.",
    }),
  ),
  provider: Type.Optional(
    Type.String({
      description:
        "Image generation provider. Currently supported: 'gemini' (default). Future: 'openai', 'xai'.",
    }),
  ),
});

// ── Types ───────────────────────────────────────────────────────────

interface GeminiImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string; // base64
        };
      }>;
    };
  }>;
  error?: {
    code: number;
    message: string;
    status: string;
  };
}

// ── Gemini Provider ─────────────────────────────────────────────────

async function generateWithGemini(opts: {
  prompt: string;
  apiKey: string;
}): Promise<{ imageData: Buffer; mimeType: string; text?: string }> {
  const model = "gemini-3-pro-image-preview";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${opts.apiKey}`;

  const body = {
    contents: [
      {
        parts: [{ text: opts.prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown");
    throw new Error(`Gemini API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as GeminiImageResponse;

  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message} (${data.error.status})`);
  }

  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error("Gemini returned no content");
  }

  // Extract image and optional text from response
  let imageData: Buffer | null = null;
  let mimeType = "image/jpeg";
  let text: string | undefined;

  for (const part of parts) {
    if (part.inlineData?.data) {
      imageData = Buffer.from(part.inlineData.data, "base64");
      mimeType = part.inlineData.mimeType || "image/jpeg";
    }
    if (part.text) {
      text = part.text;
    }
  }

  if (!imageData) {
    throw new Error(
      `Gemini did not return an image. ${text ? `Response text: ${text}` : "No text response either."}`,
    );
  }

  return { imageData, mimeType, text };
}

// ── Media Helpers ───────────────────────────────────────────────────

function resolveMediaDir(): string {
  return path.join(resolveConfigDir(), "media", "generated");
}

function mimeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return map[mimeType] ?? ".jpg";
}

async function saveGeneratedImage(
  imageData: Buffer,
  mimeType: string,
  outputPath?: string,
): Promise<string> {
  if (outputPath) {
    const dir = path.dirname(outputPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(outputPath, imageData);
    return outputPath;
  }

  const mediaDir = resolveMediaDir();
  await fs.mkdir(mediaDir, { recursive: true, mode: 0o700 });
  const ext = mimeToExt(mimeType);
  const id = crypto.randomUUID();
  const filename = `${id}${ext}`;
  const dest = path.join(mediaDir, filename);
  await fs.writeFile(dest, imageData, { mode: 0o600 });
  return dest;
}

// ── Resolve API Key ─────────────────────────────────────────────────

function resolveGeminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY ?? null;
}

// ── Tool Factory ────────────────────────────────────────────────────

export function createImageGenerateTool(): AnyAgentTool {
  return {
    label: "ImageGenerate",
    name: "image_generate",
    description:
      "Generate an image from a text prompt using AI image generation (Gemini 3 Pro). Returns a MEDIA: path to the generated image. Use for creating illustrations, diagrams, concept art, or any visual content. The more specific and descriptive the prompt, the better the results.",
    parameters: ImageGenerateSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rawPrompt = readStringParam(params, "prompt", { required: true });
      const style = readStringParam(params, "style");
      const aspectRatio = readStringParam(params, "aspectRatio");
      const outputPath = readStringParam(params, "outputPath");
      const provider = readStringParam(params, "provider") ?? "gemini";

      // Build the full prompt with style and aspect ratio hints
      let fullPrompt = rawPrompt;
      if (style) {
        fullPrompt += `. Style: ${style}`;
      }
      if (aspectRatio) {
        fullPrompt += `. Aspect ratio: ${aspectRatio}`;
      }

      try {
        if (provider === "gemini") {
          const apiKey = resolveGeminiApiKey();
          if (!apiKey) {
            return {
              content: [
                {
                  type: "text",
                  text: "Error: GEMINI_API_KEY environment variable is not set. Cannot generate images without a Gemini API key.",
                },
              ],
              details: {},
            };
          }

          const result = await generateWithGemini({
            prompt: fullPrompt,
            apiKey,
          });

          const savedPath = await saveGeneratedImage(result.imageData, result.mimeType, outputPath);

          const sizeKb = (result.imageData.length / 1024).toFixed(1);
          const lines: string[] = [];
          lines.push(`MEDIA:${savedPath}`);
          lines.push(`Generated image (${sizeKb}KB, ${result.mimeType}) saved to: ${savedPath}`);
          if (result.text) {
            lines.push(`Model note: ${result.text}`);
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              provider: "gemini",
              model: "gemini-3-pro-image-preview",
              savedPath,
              sizeBytes: result.imageData.length,
              mimeType: result.mimeType,
              prompt: fullPrompt,
            },
          };
        }

        // Future: OpenAI, xAI providers
        return {
          content: [
            {
              type: "text",
              text: `Error: Unsupported image generation provider: '${provider}'. Currently supported: 'gemini'.`,
            },
          ],
          details: {},
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Image generation failed: ${message}`,
            },
          ],
          details: { error: message, provider },
        };
      }
    },
  };
}
