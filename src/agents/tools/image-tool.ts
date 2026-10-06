import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import { Type } from "typebox";
import { findCapabilityProviderById } from "../../../packages/media-generation-core/src/capability-model-ref.js";
import { normalizeMediaProviderId } from "../../../packages/media-understanding-common/src/provider-id.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureAmbientGatewayOperatorAuthority } from "../../gateway/operator-invocation-authority.js";
import {
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import type { ImageCompressionPolicy } from "../../media/web-media.js";
import { resolvePluginCapabilityProvider } from "../../plugins/capability-provider-runtime.js";
import { runWithAsyncWorkResources } from "../../shared/async-work-resources.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { isMinimaxVlmProvider } from "../minimax-vlm.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import { createSandboxBridgeReadFile } from "../sandbox-media-paths.js";
import { optionalFiniteNumberSchema, optionalPositiveIntegerSchema } from "../schema/typebox.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import { readFiniteNumberParam, readPositiveIntegerParam, type AnyAgentTool } from "./common.js";
import {
  coerceImageModelConfig,
  decodeDataUrl,
  type ImageModelConfig,
  resolveConfiguredImageModelRefs,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";
import {
  prepareImageCompressionPolicy,
  resolveImageModelConfigForOverride,
  runImagePrompt,
} from "./image-tool.model-execution.js";
import { buildNativeImageToolResult, type LoadedImageForTool } from "./image-tool.result.js";
import {
  buildMediaReferenceDetails,
  buildTextToolResult,
  normalizeMediaReferenceList,
  REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS,
  resolveMediaToolSandboxConfig,
  resolveMediaToolInboundRoots,
  resolveMediaToolReferenceAccess,
  resolvePromptAndModelOverride,
  type MediaToolSandbox,
} from "./media-tool-shared.js";
import {
  buildToolModelConfigFromCandidates,
  hasToolModelConfig,
  prepareToolAuthProfileStoreSource,
  resolveDefaultModelRef,
  resolveOpenAiImageMediaCandidate,
} from "./model-config.helpers.js";
import { textResult } from "./tool-results.js";

const DEFAULT_PROMPT = "Describe the image.";
const DEFAULT_MAX_IMAGES = 20;

function modelRefProvider(candidate: string | null | undefined): string | undefined {
  const trimmed = candidate?.trim();
  if (!trimmed?.includes("/")) {
    return undefined;
  }
  return trimmed.slice(0, trimmed.indexOf("/")).trim();
}

function isExecutionAliasCandidateForProvider(
  candidate: string | null | undefined,
  provider: string,
): boolean {
  const candidateProvider = modelRefProvider(candidate);
  return Boolean(
    candidateProvider &&
    candidateProvider !== normalizeMediaProviderId(candidateProvider) &&
    normalizeMediaProviderId(candidateProvider) === normalizeMediaProviderId(provider),
  );
}

/**
 * Resolve the effective image model config for the `view_image` tool.
 *
 * - Prefer explicit config (`agents.defaults.imageModel`).
 * - Otherwise, try to "pair" the primary model with an image-capable model:
 *   - same provider (best effort)
 *   - fall back to OpenAI/Anthropic when available
 */
function resolveImageModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  workspaceDir?: string;
  authStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}): ImageModelConfig | null {
  // Native-vision runs route post-prompt image bytes to the active model, not fallback config.
  const explicit = coerceImageModelConfig(params.cfg);
  if (hasToolModelConfig(explicit)) {
    return resolveConfiguredImageModelRefs({
      cfg: params.cfg,
      imageModelConfig: explicit,
    });
  }

  const primary = resolveDefaultModelRef(params.cfg);
  let verifiedSubstituteProvider: string | undefined;
  const resolveCodexMediaRoute = () => {
    const preparedProviders =
      params.preparedModelRuntime?.mediaCapabilityProviders?.mediaUnderstandingProviders;
    const provider = preparedProviders
      ? findCapabilityProviderById({
          providers: preparedProviders,
          providerId: "codex",
          normalizeProviderId: normalizeMediaProviderId,
        })
      : resolvePluginCapabilityProvider({
          key: "mediaUnderstandingProviders",
          providerId: "codex",
          cfg: params.cfg,
        });
    if (!provider?.capabilities?.includes("image")) {
      return undefined;
    }
    const model = resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId: "codex",
      capability: "image",
      providerRegistry: new Map([[provider.id, provider]]),
      includeConfiguredImageModels: false,
    });
    return model ? { model } : undefined;
  };
  const resolveImplicitOpenAiImageCandidate = (openAiModel: string): string | null => {
    const decision = resolveOpenAiImageMediaCandidate({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
      openAiModel,
      resolveCodexMediaRoute,
    });
    if (decision.kind === "substitute") {
      verifiedSubstituteProvider = decision.provider;
      return decision.ref;
    }
    return decision.kind === "keep" ? decision.ref : null;
  };

  const providerVisionFromConfig = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const primaryModelId = providerVisionFromConfig
    ? providerVisionFromConfig.slice(providerVisionFromConfig.indexOf("/") + 1)
    : resolveDefaultMediaModel({
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        providerId: primary.provider,
        capability: "image",
        includeConfiguredImageModels: !isMinimaxVlmProvider(primary.provider),
      });
  const primaryCandidates =
    providerVisionFromConfig || primaryModelId
      ? [
          primary.provider === "openai"
            ? resolveImplicitOpenAiImageCandidate(primaryModelId ?? "")
            : (providerVisionFromConfig ?? `${primary.provider}/${primaryModelId}`),
        ]
      : isMinimaxVlmProvider(primary.provider)
        ? [`${primary.provider}/MiniMax-VL-01`]
        : [];

  const rawAutoCandidates = resolveAutoMediaKeyProviders({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    capability: "image",
  }).map((providerId) => {
    const modelId = resolveDefaultMediaModel({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      providerId,
      capability: "image",
      includeConfiguredImageModels: !isMinimaxVlmProvider(providerId),
    });
    if (!modelId) {
      return null;
    }
    return providerId === "openai"
      ? resolveImplicitOpenAiImageCandidate(modelId)
      : `${providerId}/${modelId}`;
  });
  const allCandidates = [...primaryCandidates, ...rawAutoCandidates];
  const autoCandidates = rawAutoCandidates.filter((candidate) => {
    const provider = modelRefProvider(candidate);
    return (
      !provider ||
      provider !== normalizeMediaProviderId(provider) ||
      !isMinimaxVlmProvider(provider) ||
      !allCandidates.some((other) => isExecutionAliasCandidateForProvider(other, provider))
    );
  });
  const defaultPrimaryIsImplicit = !resolveAgentModelPrimaryValue(
    params.cfg?.agents?.defaults?.model,
  );
  const primaryAliasCandidates = defaultPrimaryIsImplicit
    ? autoCandidates.filter((candidate) =>
        isExecutionAliasCandidateForProvider(candidate, primary.provider),
      )
    : [];
  const remainingAutoCandidates =
    primaryAliasCandidates.length === 0
      ? autoCandidates
      : autoCandidates.filter((candidate) => !primaryAliasCandidates.includes(candidate));

  return buildToolModelConfigFromCandidates({
    explicit,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    authStore: params.authStore,
    authProfileStoreSource: params.authProfileStoreSource,
    candidates: [...primaryAliasCandidates, ...primaryCandidates, ...remainingAutoCandidates],
    isProviderConfigured: (provider) =>
      verifiedSubstituteProvider && provider === verifiedSubstituteProvider ? true : undefined,
  });
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.imageToolTestApi")] = {
    resolveImageModelConfigForTool,
  };
}

function pickMaxBytes(cfg?: OpenClawConfig, maxBytesMb?: number): number | undefined {
  const limit =
    asPositiveFiniteNumber(maxBytesMb) ?? asPositiveFiniteNumber(cfg?.agents?.defaults?.mediaMaxMb);
  return limit === undefined ? undefined : Math.floor(limit * 1024 * 1024);
}

export function createImageTool(options?: {
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  authProfileStoreSource?: boolean;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  sandbox?: MediaToolSandbox;
  cwd?: string;
  fsPolicy?: ToolFsPolicy;
  agentChannel?: string | null;
  agentAccountId?: string | null;
  currentChannelId?: string | null;
  /** If true, the model has native vision capability and images in the prompt are auto-injected */
  modelHasVision?: boolean;
  /**
   * Avoid resolving auto image-provider/model candidates while registering the
   * tool. The concrete image model is still resolved before execution.
   */
  deferAutoModelResolution?: boolean;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  const modelHasVision = options?.modelHasVision === true;
  const explicit = coerceImageModelConfig(options?.config);
  if (!agentDir) {
    if (hasToolModelConfig(explicit)) {
      throw new Error("createImageTool requires agentDir when enabled");
    }
    return null;
  }
  const explicitImageModelConfig =
    !modelHasVision && hasToolModelConfig(explicit)
      ? resolveConfiguredImageModelRefs({
          cfg: options?.config,
          imageModelConfig: explicit,
        })
      : null;
  const shouldResolveAutoImageModel =
    !modelHasVision && !explicitImageModelConfig && !options?.deferAutoModelResolution;
  const resolvedImageModelConfig = shouldResolveAutoImageModel
    ? resolveImageModelConfigForTool({
        cfg: options?.config,
        agentDir,
        workspaceDir: options?.workspaceDir,
        authStore: options?.authProfileStore,
        authProfileStoreSource: options?.authProfileStoreSource,
        preparedModelRuntime: options?.preparedModelRuntime,
      })
    : explicitImageModelConfig;
  if (!modelHasVision && !resolvedImageModelConfig && !options?.deferAutoModelResolution) {
    return null;
  }
  const remoteMediaSsrfPolicy = options?.config?.tools?.web?.fetch?.ssrfPolicy;

  const description = modelHasVision
    ? "Load image(s) into private model context for inspection: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user. Prompt images are already visible."
    : explicitImageModelConfig
      ? "Inspect image(s) in private model context with the configured model: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user."
      : "Inspect image(s) in private model context with available vision: path accepts one local image path or permitted URL; paths accepts up to maxImages entries (20 by default). Does not display, attach, or send files to the user.";

  return {
    label: "View Image",
    name: "view_image",
    description,
    ...(modelHasVision ? { catalogMode: "direct-only" as const } : {}),
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      path: Type.Optional(Type.String({ description: "One local image path or permitted URL." })),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Local image paths or permitted URLs; maxImages default 20.",
        }),
      ),
      ...(modelHasVision ? {} : { model: Type.Optional(Type.String()) }),
      maxBytesMb: optionalFiniteNumberSchema({ exclusiveMinimum: 0 }),
      maxImages: optionalPositiveIntegerSchema(),
    }),
    execute: async (_toolCallId, args, suppliedSignal) =>
      runWithAsyncWorkResources(async (onAcquired) => {
        const record: Record<string, unknown> = args && typeof args === "object" ? { ...args } : {};
        if (Array.isArray(record.paths)) {
          record.paths = [...record.paths];
        }
        const capturedOperator = await captureAmbientGatewayOperatorAuthority({
          missingBindingError: () =>
            new Error("Image analysis requires its current Gateway binding."),
          retainInherited: true,
        });
        if (capturedOperator.release) {
          onAcquired({ release: capturedOperator.release });
        }
        const operatorAuthority = capturedOperator.authority;
        const signal = operatorAuthority?.signal
          ? suppliedSignal
            ? AbortSignal.any([suppliedSignal, operatorAuthority.signal])
            : operatorAuthority.signal
          : suppliedSignal;
        const assertCurrent = () => {
          capturedOperator.assertInvocationCurrent?.();
          operatorAuthority?.assertCurrent();
          signal?.throwIfAborted();
        };
        assertCurrent();
        const pathInputs = normalizeMediaReferenceList([
          ...(typeof record.path === "string" ? [record.path] : []),
          ...filterStringEntries(record.paths),
        ]);
        if (pathInputs.length === 0) {
          throw new Error("path required");
        }

        const maxImages = readPositiveIntegerParam(record, "maxImages") ?? DEFAULT_MAX_IMAGES;
        if (pathInputs.length > maxImages) {
          return textResult(
            `Too many images: ${pathInputs.length} provided, maximum is ${maxImages}. Please reduce the number of images.`,
            { error: "too_many_images", count: pathInputs.length, max: maxImages },
          );
        }

        const { prompt: promptRaw, modelOverride } = resolvePromptAndModelOverride(
          record,
          DEFAULT_PROMPT,
        );
        const maxBytesMb = readFiniteNumberParam(record, "maxBytesMb", {
          min: 0,
          minExclusive: true,
          message: "maxBytesMb must be greater than 0",
        });
        const maxBytes = pickMaxBytes(options?.config, maxBytesMb);
        let imageRoute:
          | { kind: "native" }
          | {
              kind: "fallback";
              imageModelConfig: ImageModelConfig;
              imageCompression: ImageCompressionPolicy;
            };
        if (modelHasVision) {
          imageRoute = { kind: "native" };
        } else {
          let imageModelConfig =
            resolvedImageModelConfig ??
            resolveImageModelConfigForOverride({
              cfg: options?.config,
              modelOverride,
            });
          if (!imageModelConfig) {
            const authProfileStoreSource = await prepareToolAuthProfileStoreSource(options);
            assertCurrent();
            imageModelConfig = resolveImageModelConfigForTool({
              cfg: options?.config,
              agentDir,
              workspaceDir: options?.workspaceDir,
              authStore: options?.authProfileStore,
              authProfileStoreSource,
              preparedModelRuntime: options?.preparedModelRuntime,
            });
          }
          if (!imageModelConfig) {
            throw new Error(
              "No image model is configured. Set agents.defaults.imageModel or configure an image-capable provider.",
            );
          }
          const imageCompression = await prepareImageCompressionPolicy({
            abortSignal: signal,
            cfg: options?.config,
            imageModelConfig,
            modelOverride,
            imageCount: pathInputs.length,
            agentDir,
            workspaceDir: options?.workspaceDir,
            preparedModelRuntime: options?.preparedModelRuntime,
            operatorAuthority,
          });
          assertCurrent();
          imageRoute = { kind: "fallback", imageModelConfig, imageCompression };
        }
        const imageCompression =
          imageRoute.kind === "fallback" ? imageRoute.imageCompression : undefined;
        const sandboxConfig = resolveMediaToolSandboxConfig(
          options?.sandbox,
          options?.fsPolicy?.workspaceOnly,
        );

        const loadedImages: LoadedImageForTool[] = [];

        for (const pathRawInput of pathInputs) {
          // Stop before starting the next sequential download/decode when the run
          // was aborted, so a dead run cannot keep pulling up to maxImages remote images.
          signal?.throwIfAborted();
          const imageRaw = pathRawInput.startsWith("@")
            ? pathRawInput.slice(1).trim()
            : pathRawInput;
          const normalizedRef = normalizeMediaReferenceSource(imageRaw);

          // Pseudo-URIs such as image:0 have no registry here; reject them before filesystem access.
          const refInfo = classifyMediaReferenceSource(normalizedRef);
          const { isDataUrl, isHttpUrl } = refInfo;
          if (refInfo.hasUnsupportedScheme) {
            return textResult(
              `Unsupported image reference: ${pathRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
              {
                error: "unsupported_image_reference",
                path: pathRawInput,
              },
            );
          }

          if (sandboxConfig && isHttpUrl) {
            throw new Error("Sandboxed view_image does not allow remote URLs.");
          }

          const {
            resolvedPath,
            localRoots: mediaLocalRoots,
            rewrittenFrom,
          } = await resolveMediaToolReferenceAccess({
            input: normalizedRef,
            isDataUrl,
            workspaceDir: options?.workspaceDir,
            cwd: options?.cwd,
            fsPolicy: options?.fsPolicy,
            sandbox: sandboxConfig,
          });
          const resolvedImage = resolvedPath ?? normalizedRef;
          const mediaInboundRoots = resolveMediaToolInboundRoots({
            workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
            cfg: options?.config,
            channelId: options?.agentChannel ?? options?.currentChannelId,
            accountId: options?.agentAccountId,
          });
          const imageWebMedia = await import("../../media/web-media.js");
          signal?.throwIfAborted();

          const decoded = isDataUrl ? decodeDataUrl(resolvedImage, { maxBytes }) : undefined;
          const media = decoded
            ? await imageWebMedia.optimizeImageBufferForWebMedia({
                buffer: decoded.buffer,
                contentType: decoded.mimeType,
                maxBytes,
                imageCompression,
              })
            : await imageWebMedia.loadWebMedia(resolvedImage, {
                maxBytes,
                imageCompression,
                ...(sandboxConfig
                  ? {
                      sandboxValidated: true,
                      readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
                    }
                  : {
                      localRoots: mediaLocalRoots,
                      inboundRoots: mediaInboundRoots,
                      ssrfPolicy: remoteMediaSsrfPolicy,
                      ...(isHttpUrl
                        ? { readIdleTimeoutMs: REMOTE_MEDIA_READ_IDLE_TIMEOUT_MS }
                        : {}),
                      // Forward the run abort signal into the fetch layer so an abort
                      // mid-download disconnects the in-flight socket.
                      ...(signal ? { requestInit: { signal } } : {}),
                    }),
              });
          signal?.throwIfAborted();
          if (media.kind !== "image") {
            throw new Error(`Unsupported media type: ${media.kind}`);
          }

          const mimeType = media.contentType ?? "image/png";
          loadedImages.push({
            buffer: media.buffer,
            mimeType,
            resolvedInput: resolvedImage,
            ...(rewrittenFrom ? { rewrittenFrom } : {}),
          });
        }

        if (imageRoute.kind === "native") {
          const result = await buildNativeImageToolResult(loadedImages, options?.config);
          signal?.throwIfAborted();
          return result;
        }

        // Do not issue a paid vision-provider call for an already-aborted run.
        signal?.throwIfAborted();
        // Text-only runs delegate image understanding to the configured fallback model.
        const result = await runImagePrompt({
          signal,
          operatorAuthority,
          assertCurrent,
          cfg: options?.config,
          agentId: options?.agentId,
          agentDir,
          authStore: options?.authProfileStore,
          imageModelConfig: imageRoute.imageModelConfig,
          modelOverride,
          prompt: promptRaw,
          images: loadedImages,
          workspaceDir: options?.workspaceDir,
          preparedModelRuntime: options?.preparedModelRuntime,
        });

        return buildTextToolResult(result, buildMediaReferenceDetails(loadedImages, "image"));
      }),
  };
}
