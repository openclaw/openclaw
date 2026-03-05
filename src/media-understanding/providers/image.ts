import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import { minimaxUnderstandImage } from "../../agents/minimax-vlm.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import { coerceImageAssistantText } from "../../agents/tools/image-tool.helpers.js";
import { convertGifFirstFrameToPng } from "../../media/image-ops.js";
import type { ImageDescriptionRequest, ImageDescriptionResult } from "../types.js";

let piModelDiscoveryRuntimePromise: Promise<
  typeof import("../../agents/pi-model-discovery-runtime.js")
> | null = null;

function loadPiModelDiscoveryRuntime() {
  piModelDiscoveryRuntimePromise ??= import("../../agents/pi-model-discovery-runtime.js");
  return piModelDiscoveryRuntimePromise;
}

export async function describeImageWithModel(
  params: ImageDescriptionRequest,
): Promise<ImageDescriptionResult> {
  await ensureOpenClawModelsJson(params.cfg, params.agentDir);
  const { discoverAuthStorage, discoverModels } = await loadPiModelDiscoveryRuntime();
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);
  const model = modelRegistry.find(params.provider, params.model) as Model<Api> | null;
  if (!model) {
    throw new Error(`Unknown model: ${params.provider}/${params.model}`);
  }
  if (!model.input?.includes("image")) {
    throw new Error(`Model does not support images: ${params.provider}/${params.model}`);
  }
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.cfg,
    agentDir: params.agentDir,
    profileId: params.profile,
    preferredProfile: params.preferredProfile,
  });
  const apiKey = requireApiKey(apiKeyInfo, model.provider);
  authStorage.setRuntimeApiKey(model.provider, apiKey);

  // Most vision APIs (Google Gemini, xAI Grok, OpenAI) reject image/gif.
  // Extract the first frame and convert to PNG so the request succeeds.
  let imageBuffer = params.buffer;
  let imageMime = params.mime ?? "image/jpeg";
  if (imageMime === "image/gif") {
    try {
      imageBuffer = await convertGifFirstFrameToPng(imageBuffer);
      imageMime = "image/png";
    } catch {
      // Conversion failed — pass through as-is; the model error will surface normally.
    }
  }

  const base64 = imageBuffer.toString("base64");
  if (model.provider === "minimax") {
    const text = await minimaxUnderstandImage({
      apiKey,
      prompt: params.prompt ?? "Describe the image.",
      imageDataUrl: `data:${imageMime};base64,${base64}`,
      modelBaseUrl: model.baseUrl,
    });
    return { text, model: model.id };
  }

  const context: Context = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: params.prompt ?? "Describe the image." },
          { type: "image", data: base64, mimeType: imageMime },
        ],
        timestamp: Date.now(),
      },
    ],
  };
  const message = await complete(model, context, {
    apiKey,
    maxTokens: params.maxTokens ?? 512,
  });
  const text = coerceImageAssistantText({
    message,
    provider: model.provider,
    model: model.id,
  });
  return { text, model: model.id };
}
