import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveGeneratedMediaMaxBytes } from "../media/configured-max-bytes.js";
import { resolveApiKeyForProvider } from "../plugin-sdk/provider-auth-runtime.js";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  postJsonRequest,
  postMultipartRequest,
  readProviderJsonResponse,
  resolveProviderHttpRequestConfig,
  resolveProviderOperationTimeoutMs,
  sanitizeConfiguredModelProviderRequest,
} from "../plugin-sdk/provider-http.js";
import {
  isProviderApiKeyConfigured,
  isProviderApiKeyConfiguredAsync,
} from "../plugins/provider-auth-availability.js";
import {
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
} from "./image-assets.js";
import type {
  ImageGenerationProvider,
  ImageGenerationProviderCapabilities,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "./types.js";

type ModelProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];

/** OpenAI-compatible image endpoint mode. */
export type OpenAiCompatibleImageRequestMode = "generate" | "edit";

export type OpenAiCompatibleImageProviderRequestParams = {
  req: ImageGenerationRequest;
  inputImages: ImageGenerationSourceImage[];
  model: string;
  count: number;
  mode: OpenAiCompatibleImageRequestMode;
};

export type OpenAiCompatibleImageProviderRequestBody =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "multipart"; form: FormData };

export type OpenAiCompatibleImageProviderOptions = {
  id: string;
  label: string;
  defaultModel: string;
  models: readonly string[];
  capabilities: ImageGenerationProviderCapabilities;
  defaultBaseUrl: string;
  providerConfigKey?: string;
  normalizeModel?: (model: string | undefined, fallback: string) => string;
  resolveBaseUrl?: (params: {
    req: ImageGenerationRequest;
    providerConfig?: ModelProviderConfig;
    defaultBaseUrl: string;
  }) => string;
  resolveAllowPrivateNetwork?: (params: {
    baseUrl: string;
    req: ImageGenerationRequest;
    providerConfig?: ModelProviderConfig;
  }) => boolean | undefined;
  useConfiguredRequest?: boolean;
  defaultTimeoutMs?: number;
  resolveCount?: (params: {
    req: ImageGenerationRequest;
    mode: OpenAiCompatibleImageRequestMode;
  }) => number;
  buildGenerateRequest: (
    params: OpenAiCompatibleImageProviderRequestParams & { mode: "generate" },
  ) => OpenAiCompatibleImageProviderRequestBody;
  buildEditRequest: (
    params: OpenAiCompatibleImageProviderRequestParams & { mode: "edit" },
  ) => OpenAiCompatibleImageProviderRequestBody;
  response?: {
    defaultMimeType?: string;
    fileNamePrefix?: string;
    sniffMimeType?: boolean;
  };
  missingApiKeyError?: string;
  tooManyInputImagesError?: string;
  missingInputImageError?: string;
  emptyResponseError?: string;
  failureLabels?: {
    generate?: string;
    edit?: string;
  };
};

/** Creates an image-generation provider backed by OpenAI-style image endpoints. */
export function createOpenAiCompatibleImageGenerationProvider(
  options: OpenAiCompatibleImageProviderOptions,
): ImageGenerationProvider {
  const providerConfigKey = options.providerConfigKey ?? options.id;
  const normalizeModel =
    options.normalizeModel ?? ((model, fallback) => normalizeOptionalString(model) ?? fallback);
  const resolveCount = options.resolveCount ?? (({ req }) => req.count ?? 1);

  return {
    id: options.id,
    label: options.label,
    defaultModel: options.defaultModel,
    ...(options.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: options.defaultTimeoutMs }
      : {}),
    models: [...options.models],
    isConfigured: (ctx) => isProviderApiKeyConfigured({ provider: options.id, ...ctx }),
    isConfiguredAsync: (ctx) => isProviderApiKeyConfiguredAsync({ provider: options.id, ...ctx }),
    capabilities: options.capabilities,
    async generateImage(req): Promise<ImageGenerationResult> {
      const inputImages = req.inputImages ?? [];
      // Reference images switch the request to edit mode; providers can still
      // disable edits or cap reference count through capabilities.
      const mode: OpenAiCompatibleImageRequestMode = inputImages.length > 0 ? "edit" : "generate";
      const operation = `${options.label} image ${mode === "edit" ? "edit" : "generation"}`;
      const maxInputImages = options.capabilities.edit.maxInputImages;
      if (mode === "edit" && !options.capabilities.edit.enabled) {
        throw new Error(`${options.label} image editing is not supported.`);
      }
      if (mode === "edit" && maxInputImages !== undefined && inputImages.length > maxInputImages) {
        throw new Error(
          options.tooManyInputImagesError ??
            `${options.label} image editing supports up to ${maxInputImages} reference image${
              maxInputImages === 1 ? "" : "s"
            }.`,
        );
      }
      const auth = await resolveApiKeyForProvider({
        provider: options.id,
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error(options.missingApiKeyError ?? `${options.label} API key missing`);
      }

      const providerConfig = req.cfg?.models?.providers?.[providerConfigKey];
      const resolvedBaseUrl =
        options.resolveBaseUrl?.({
          req,
          providerConfig,
          defaultBaseUrl: options.defaultBaseUrl,
        }) ??
        normalizeOptionalString(providerConfig?.baseUrl) ??
        options.defaultBaseUrl;
      const allowPrivateNetwork = options.resolveAllowPrivateNetwork?.({
        baseUrl: resolvedBaseUrl,
        req,
        providerConfig,
      });
      const {
        baseUrl,
        allowPrivateNetwork: resolvedAllowPrivateNetwork,
        headers,
        dispatcherPolicy,
      } = resolveProviderHttpRequestConfig({
        baseUrl: resolvedBaseUrl,
        defaultBaseUrl: options.defaultBaseUrl,
        allowPrivateNetwork,
        request: options.useConfiguredRequest
          ? sanitizeConfiguredModelProviderRequest(providerConfig?.request)
          : undefined,
        defaultHeaders: {
          Authorization: `Bearer ${auth.apiKey}`,
        },
        provider: options.id,
        capability: "image",
        transport: "http",
      });

      const model = normalizeModel(req.model, options.defaultModel);
      const count = resolveCount({ req, mode });
      const requestParams = { req, inputImages, model, count, mode };
      const requestBody =
        mode === "edit"
          ? options.buildEditRequest({ ...requestParams, mode })
          : options.buildGenerateRequest({ ...requestParams, mode });
      const timeoutMs =
        options.defaultTimeoutMs === undefined
          ? req.timeoutMs
          : resolveProviderOperationTimeoutMs({
              deadline: createProviderOperationDeadline({
                timeoutMs: req.timeoutMs,
                label: options.failureLabels?.[mode] ?? operation,
              }),
              defaultTimeoutMs: options.defaultTimeoutMs,
            });
      // Multipart requests must let FormData set its own boundary header, while
      // JSON requests need an explicit content type after configured headers.
      const requestOptions = {
        url: `${baseUrl.replace(/\/+$/u, "")}/images/${mode === "edit" ? "edits" : "generations"}`,
        headers: new Headers(headers),
        timeoutMs,
        fetchFn: fetch,
        allowPrivateNetwork: resolvedAllowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
      };
      if (requestBody.kind === "multipart") {
        requestOptions.headers.delete("Content-Type");
      } else {
        requestOptions.headers.set("Content-Type", "application/json");
      }
      const request =
        requestBody.kind === "multipart"
          ? postMultipartRequest({ ...requestOptions, body: requestBody.form })
          : postJsonRequest({ ...requestOptions, body: requestBody.body });

      const { response, release } = await request;
      try {
        await assertOkOrThrowHttpError(
          response,
          options.failureLabels?.[mode] ?? `${operation} failed`,
        );
        const payload = await readProviderJsonResponse(response, `${options.id}.image-generation`, {
          maxBytes: resolveInlineImageJsonResponseMaxBytes(
            options.capabilities[mode].maxCount ?? count,
            resolveGeneratedMediaMaxBytes(req.cfg, "image"),
          ),
        });
        const images = parseOpenAiCompatibleImageResponse(payload, {
          ...options.response,
          malformedResponseError: `${operation} response malformed`,
        });
        if (images.length === 0) {
          throw new Error(options.emptyResponseError ?? `${operation} response missing image data`);
        }
        return { images, model };
      } finally {
        await release();
      }
    },
  };
}
