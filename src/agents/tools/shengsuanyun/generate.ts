import { Type, type TSchema } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../../config/config.ts";
import type { AnyAgentTool } from "../common.ts";
import { loadConfig } from "../../../config/config.ts";
import { resolveApiKeyForProvider } from "../../model-auth.ts";
import {
  getShengSuanYunModalityModels,
  SHENGSUANYUN_BASE_URL,
  TaskRes,
} from "../../shengsuanyun-models.ts";
import { readStringParam, readStringArrayParam, readNumberParam } from "../common.ts";
import { createGemini3ProImageTool } from "./gemini3pro-image-preview.ts";
import { createZImageTurboTool } from "./zimage-turbo.ts";

export const APP_HEADERS: Record<string, string> = {
  "HTTP-Referer": "https://openclaw.ai",
  "X-Title": "OpenClaw",
  "Content-Type": "application/json",
};

async function generate(
  params: Record<string, unknown>,
): Promise<{ success: boolean; Urls?: string[]; error?: string }> {
  try {
    const { apiKey, ...rest } = params;
    const res = await fetch(`${SHENGSUANYUN_BASE_URL}/tasks/generations`, {
      method: "POST",
      headers: {
        ...APP_HEADERS,
        Authorization: `Bearer ${apiKey as string}`,
      },
      body: JSON.stringify(rest),
    });

    if (!res.ok) {
      return { success: false, error: `API Error: ${res.statusText}` };
    }
    const data = (await res.json()) as TaskRes;
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
              ...APP_HEADERS,
              Authorization: `Bearer ${String(params.apiKey)}`,
            },
            signal: AbortSignal.timeout(30000),
          },
        );
        if (!imgs.ok) {
          await new Promise((resolve) => setTimeout(resolve, 20000));
          continue;
        }
        const img_urls = (await imgs.json()) as TaskRes;
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
          return { success: true, Urls: img_urls.data?.data?.image_urls };
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

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/_+/g, "_");
}

async function loadShengSuanYunTools(opts?: { config?: OpenClawConfig }): Promise<AnyAgentTool[]> {
  const models = await getShengSuanYunModalityModels();
  const tools: AnyAgentTool[] = [];
  for (const model of models) {
    const label = `${model.company_name} ${model.model_name} Generate tool`;
    const name = sanitizeToolName(`${model.company_name}_${model.model_name}`);
    const description = `Generate content using the ${model.company_name} ${model.model_name} model. ${model.desc}`;
    let inputSchema: JsonSchema = {};
    try {
      inputSchema = JSON.parse(model.input_schema) as JsonSchema;
    } catch (e) {
      console.log(`[shengsuanyun-generate] Parse input_schema error for ${model.model_name}:`, e);
      continue;
    }
    const parameters = generateTypebox(inputSchema);
    tools.push({
      label,
      name,
      description,
      parameters,
      execute: async (_toolCallId, args) => {
        const cfg = opts?.config ?? loadConfig();
        const resolved = await resolveApiKeyForProvider({ provider: "shengsuanyun", cfg });
        if (!resolved.apiKey) {
          throw new Error("ShengSuanYun API key not configured");
        }
        const params = args as Record<string, unknown>;
        const apiParams: Record<string, unknown> = { model: model.api_name };
        const extractParams = (schema: JsonSchema) => {
          if (!schema.properties) {
            return;
          }
          for (const [key, prop] of Object.entries(
            schema.properties as Record<string, JsonSchema>,
          )) {
            const isRequired = schema.required?.includes(key);

            if (prop.type === "array") {
              const value = readStringArrayParam(params, key, { required: isRequired });
              if (value !== undefined) {
                apiParams[key] = value;
              }
            } else if (prop.type === "number" || prop.type === "integer") {
              const value = readNumberParam(params, key, { required: isRequired });
              if (value !== undefined) {
                apiParams[key] = value;
              }
            } else {
              const value = readStringParam(params, key, { required: isRequired });
              if (value !== undefined) {
                apiParams[key] = value;
              }
            }
          }
        };

        if (inputSchema.anyOf && Array.isArray(inputSchema.anyOf)) {
          for (const subSchema of inputSchema.anyOf) {
            extractParams(subSchema);
          }
        } else {
          extractParams(inputSchema);
        }

        const result = await generate({ ...apiParams, apiKey: resolved.apiKey });
        if (result.success && result.Urls) {
          const lines: string[] = [];
          for (const url of result.Urls) {
            lines.push(`MEDIA:${url}`);
          }
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: {
              Url: result.Urls,
              provider: "shengsuanyun",
            },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: result.error ?? "Content generation failed",
            },
          ],
          details: { error: result.error },
        };
      },
    });
  }
  console.log(`[shengsuanyun-generate] Loaded ${tools.length} dynamic tools`);
  return tools;
}

interface JsonSchema {
  $schema?: string;
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: Array<string | number>;
  format?: string;
  ssy?: string;
  [key: string]: unknown;
}

export function generateTypebox(schema: JsonSchema): TSchema {
  const getOptions = (s: JsonSchema): Record<string, unknown> => {
    const options: Record<string, unknown> = {};
    if (s.title) {
      options.title = s.title;
    }
    if (s.description) {
      options.description = s.description;
    }
    if (s.default !== undefined) {
      options.default = s.default;
    }
    return options;
  };

  const parse = (node: JsonSchema): TSchema => {
    const options = getOptions(node);

    // Handle anyOf as Union
    if (node.anyOf && Array.isArray(node.anyOf)) {
      const unions = node.anyOf.map((item: JsonSchema) => parse(item));
      return Type.Union(unions, Object.keys(options).length > 0 ? options : undefined);
    }

    // Handle enum as Union of Literals
    if (node.enum && Array.isArray(node.enum)) {
      const literals = node.enum.map((val: string | number) => Type.Literal(val));
      return Type.Union(literals, Object.keys(options).length > 0 ? options : undefined);
    }

    // Handle object type
    if (node.type === "object" || node.properties) {
      if (!node.properties) {
        return Type.Object({}, Object.keys(options).length > 0 ? options : undefined);
      }

      const props: Record<string, TSchema> = {};
      for (const [key, value] of Object.entries(node.properties as Record<string, JsonSchema>)) {
        const isRequired =
          node.required && Array.isArray(node.required) && node.required.includes(key);
        const propSchema = parse(value);
        props[key] = isRequired ? propSchema : Type.Optional(propSchema);
      }

      return Type.Object(props, Object.keys(options).length > 0 ? options : undefined);
    }

    // Handle array type
    if (node.type === "array") {
      const itemsSchema = node.items ? parse(node.items) : Type.Any();
      return Type.Array(itemsSchema, Object.keys(options).length > 0 ? options : undefined);
    }

    // Handle primitive types
    if (node.type === "string" || (!node.type && !node.anyOf && !node.enum)) {
      return Type.String(Object.keys(options).length > 0 ? options : undefined);
    }
    if (node.type === "number" || node.type === "integer") {
      return Type.Number(Object.keys(options).length > 0 ? options : undefined);
    }
    if (node.type === "boolean") {
      return Type.Boolean(Object.keys(options).length > 0 ? options : undefined);
    }

    return Type.Unknown();
  };

  return parse(schema);
}

// const inputSchema = {"$schema": "https://json-schema.org/draft/2020-12/schema","anyOf": [{"properties": {"prompt": {"type": "string","format": "textarea","title": "提示词","description": "描述你想生成的视频内容"},"seconds": {"type": "string","title": "视频时长（秒）","default": "4","enum": ["4", "8", "12"],"description": "生成的视频时长，单位为秒，默认4秒"},"size": {"type": "string","enum": ["720x1280", "1280x720"],"title": "输出分辨率","default": "720x1280","description": "输出分辨率，格式为 宽x高"}},"type": "object","required": ["prompt"],"title": "文生视频"},{"properties": {"prompt": {"type": "string","format": "textarea","title": "提示词","description": "描述你想生成的视频内容"},"input_reference": {"type": "string","title": "参考图片","ssy": "image","description": "用于引导视频生成的参考图片"},"seconds": {"type": "string","title": "视频时长（秒）","default": "4","enum": ["4", "8", "12"],"description": "生成的视频时长，单位为秒，默认4秒"},"size": {"type": "string","enum": ["720x1280", "1280x720"],"title": "输出分辨率","default": "720x1280","description": "输出分辨率，格式为 宽x高"}},"type": "object","required": ["prompt", "input_reference"],"title": "图生视频"}],"type": "object"};
// const code = generateTypebox(inputSchema);
// console.log(code);

// Fallback tools that are always available
let cachedTools: AnyAgentTool[] | null = null;
let loadPromise: Promise<AnyAgentTool[]> | null = null;

export async function preloadShengSuanYunTools(opts?: { config?: OpenClawConfig }): Promise<void> {
  if (cachedTools !== null) {
    return;
  }

  if (loadPromise !== null) {
    await loadPromise;
    return;
  }
  loadPromise = loadShengSuanYunTools(opts)
    .then((tools) => {
      const fallbackTools = [createZImageTurboTool(opts), createGemini3ProImageTool(opts)];
      cachedTools = [...tools, ...fallbackTools];
      return cachedTools;
    })
    .catch((err) => {
      console.error("[shengsuanyun-generate] Failed to load tools, using fallback only:", err);
      const fallbackTools = [createZImageTurboTool(opts), createGemini3ProImageTool(opts)];
      cachedTools = fallbackTools;
      return cachedTools;
    })
    .finally(() => {
      loadPromise = null;
    });
  await loadPromise;
}

export function createGenerateTools(opts?: { config?: OpenClawConfig }): AnyAgentTool[] {
  if (cachedTools !== null) {
    return cachedTools;
  }
  preloadShengSuanYunTools(opts).catch((err) => {
    console.error("[shengsuanyun-generate] Background preload failed:", err);
  });
  const fallbackTools = [createZImageTurboTool(opts), createGemini3ProImageTool(opts)];
  return fallbackTools;
}
