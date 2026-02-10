import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../../config/config.js";
import type { AnyAgentTool } from "../common.js";
import { loadConfig } from "../../../config/config.js";
import { resolveApiKeyForProvider } from "../../model-auth.ts";
import { SHENGSUANYUN_BASE_URL } from "../../shengsuanyun-models.ts";
import { readStringArrayParam, readStringParam } from "../common.js";
import { APP_HEADERS, TaskResponse } from "./zimage-turbo.ts";

const ImageGenSchema = Type.Object({
  prompt: Type.String({
    description: "The prompt description for generating the image.",
  }),
  aspect_ratio: Type.Optional(
    Type.String({
      description: "Aspect ratio of the image. Defaults to 1:1.",
      enum: ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: "Material or pictureUrl array that needs to be edited",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Resolution size. Defaults to 1K.",
      enum: ["1K", "2K", "4K"],
    }),
  ),
});

async function generateImage(params: {
  aspect_ratio: string;
  images?: string[];
  prompt: string;
  size: string;
  apiKey?: string;
}): Promise<{ success: boolean; imageUrls?: string[]; error?: string }> {
  try {
    const res = await fetch(`${SHENGSUANYUN_BASE_URL}/tasks/generations`, {
      method: "POST",
      headers: {
        ...APP_HEADERS,
        Authorization: `Bearer ${params.apiKey || ""}`,
      },
      body: JSON.stringify({
        model: "ali/gemini-3-pro-image-preview",
        prompt: params.prompt,
        images: params.images,
        aspect_ratio: params.aspect_ratio,
        size: params.size,
      }),
    });

    if (!res.ok) {
      return { success: false, error: `API Error: ${res.statusText}` };
    }
    const data = (await res.json()) as TaskResponse;
    if (data.code != "success" || !data.data?.request_id) {
      return { success: false, error: data.message || "No image URL returned in response" };
    }
    let trys = 0;
    while (trys < 18) {
      trys += 1;
      try {
        const imgs = await fetch(
          `${SHENGSUANYUN_BASE_URL}/tasks/generations/${data.data?.request_id}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${String(params.apiKey)}`,
            },
            signal: AbortSignal.timeout(30000), // 30s timeout for polling
          },
        );
        if (!imgs.ok) {
          await new Promise((resolve) => setTimeout(resolve, 20000));
          continue;
        }
        const img_urls = (await imgs.json()) as TaskResponse;
        if (img_urls.code != "success") {
          await new Promise((resolve) => setTimeout(resolve, 20000));
          continue;
        }
        if (img_urls.data?.status === "FAILED") {
          return {
            success: false,
            error: img_urls.data?.fail_reason || "Image generation failed",
          };
        }
        if (img_urls.data?.data?.progress == 100) {
          return { success: true, imageUrls: img_urls.data?.data?.image_urls };
        }
        await new Promise((resolve) => setTimeout(resolve, 20000));
      } catch (e) {
        console.log("createGemini3ProImageTool() error:", e);
        await new Promise((resolve) => setTimeout(resolve, 20000));
      }
    }
    return { success: false, error: "6 minutes timeout!" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export function createGemini3ProImageTool(opts?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "Gemini 3 Pro Image Generation",
    name: "gemini3pro_image_gen",
    description:
      "Generate images based on a text prompt using Google Gemini 3 Pro Image Preview model. Returns a MEDIA: path. Use when the user asks to draw, paint, or generate pictures.",
    parameters: ImageGenSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      // Parse parameters using your utility
      const prompt = readStringParam(params, "prompt", { required: true });
      const aspectRatio = readStringParam(params, "aspect_ratio") ?? "1:1";
      const size = readStringParam(params, "size") ?? "1K";
      const images = readStringArrayParam(params, "images") ?? undefined;
      const cfg = opts?.config ?? loadConfig();
      const resolved = await resolveApiKeyForProvider({ provider: "shengsuanyun", cfg });
      if (!resolved.apiKey) {
        throw new Error("ShengSuanYun API key not configured");
      }
      const result = await generateImage({
        prompt,
        images,
        aspect_ratio: aspectRatio,
        size,
        apiKey: resolved.apiKey,
      });

      if (result.success && result.imageUrls) {
        const lines: string[] = [];
        for (const url of result.imageUrls) {
          lines.push(`MEDIA:${url}`);
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            imageUrl: result.imageUrls,
            provider: "shengsuanyun",
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: result.error ?? "Image generation failed",
          },
        ],
        details: { error: result.error },
      };
    },
  };
}
