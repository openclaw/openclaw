import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../../config/config.ts";
import type { AnyAgentTool } from "../common.ts";
import { loadConfig } from "../../../config/config.ts";
import { resolveApiKeyForProvider } from "../../model-auth.ts";
import { SHENGSUANYUN_BASE_URL } from "../../shengsuanyun-models.ts";
import { readStringParam } from "../common.ts";

export const APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
  "Content-Type": "application/json",
};

const ImageGenSchema = Type.Object({
  prompt: Type.String({
    description: "The prompt description for generating the image.",
  }),
  size: Type.Optional(
    Type.String({
      description:
        "Resolution size in format width*height (e.g., 1024*1024, 512*512). Use asterisk (*) not x. Defaults to 1024*1024.",
    }),
  ),
});

export interface TaskResponse {
  code?: string;
  message?: string;
  data?: {
    progress?: string;
    request_id?: string;
    status?: string;
    fail_reason?: string;
    data?: {
      image_urls?: string[];
      progress?: number;
      error?: string;
    };
  };
}

async function generateImage(params: {
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
        model: "ali/z-image-turbo",
        prompt: params.prompt,
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
        console.log("createZImageTurboTool() error:", e);
        await new Promise((resolve) => setTimeout(resolve, 20000));
      }
    }
    return { success: false, error: "6 minutes timeout!" };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export function createZImageTurboTool(opts?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "Z-Image Turbo Generation",
    name: "zimage_turbo_gen",
    description:
      "Generate images based on a text prompt using Ali Z-Image-Turbo model. Returns a MEDIA: path. Use when the user asks to draw, paint, or generate pictures.",
    parameters: ImageGenSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const prompt = readStringParam(params, "prompt", { required: true });
      const size = readStringParam(params, "size") ?? "1024*1024";
      const cfg = opts?.config ?? loadConfig();
      const resolved = await resolveApiKeyForProvider({ provider: "shengsuanyun", cfg });
      if (!resolved.apiKey) {
        throw new Error("ShengSuanYun API key not configured");
      }
      const result = await generateImage({ prompt, size, apiKey: resolved.apiKey });
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
            text: result.error ?? "Images generation failed",
          },
        ],
        details: { error: result.error },
      };
    },
  };
}
