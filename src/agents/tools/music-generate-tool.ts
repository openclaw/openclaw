import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseMusicGenerationModelRef } from "../../media-generation/model-ref.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { listRuntimeMusicGenerationProviders } from "../../music-generation/runtime.js";
import type { MusicGenerationOutputFormat } from "../../music-generation/types.js";
import { readBooleanParam } from "../../plugin-sdk/boolean-param.js";
import { buildMediaGenerationRequestKey } from "../media-generation-task-status-shared.js";
import { ToolInputError, readToolStringParam, type AnyAgentTool } from "./common.js";
import type { MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
import {
  musicGenerationTaskLifecycle,
  prepareMediaGenerationTask,
  resolveMediaGenerateToolContext,
  type MediaGenerateToolOptions,
} from "./media-generate-background.js";
import { createMediaGenerateExecute } from "./media-generate-tool-actions-shared.js";
import { acquireMediaGenerationToolProviders } from "./media-generation-tool-providers.js";
import {
  buildMediaReferenceDetails,
  MEDIA_GENERATE_DESCRIPTIONS,
  loadMediaToolReferences,
  normalizeMediaReferenceInputs,
  readGenerationDurationSeconds,
  resolveSelectedCapabilityProvider,
} from "./media-tool-shared.js";
import {
  createMusicGenerateDuplicateGuardResult,
  createMusicGenerateListActionResult,
  createMusicGenerateStatusActionResult,
} from "./music-generate-tool.actions.js";
import {
  executeMusicGenerationJob,
  normalizeMusicGenerationTimeoutMs,
} from "./music-generate-tool.execution.js";

const log = createSubsystemLogger("agents/tools/music-generate");
const MAX_INPUT_IMAGES = 10;

const MusicGenerateToolSchema = Type.Object({
  action: Type.Optional(Type.String({ description: MEDIA_GENERATE_DESCRIPTIONS.action })),
  prompt: Type.Optional(Type.String({ description: "Music prompt: style, genre, mood, purpose." })),
  lyrics: Type.Optional(
    Type.String({
      description:
        "Exact sung lyrics only when the user supplies lyrics or asks for vocal words. For song/style requests, use prompt instead.",
    }),
  ),
  instrumental: Type.Optional(
    Type.Boolean({
      description: "Instrumental-only toggle.",
    }),
  ),
  image: Type.Optional(
    Type.String({
      description: "Reference image path/URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Reference images; max ${MAX_INPUT_IMAGES}.`,
    }),
  ),
  model: Type.Optional(
    Type.String({
      description: "Provider/model override, e.g. google/lyria-3-pro-preview.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Integer({
      description: "Target seconds; provider may clamp.",
      minimum: 1,
    }),
  ),
  format: Type.Optional(
    Type.String({
      description: "Output format: mp3, wav.",
    }),
  ),
  filename: Type.Optional(Type.String({ description: MEDIA_GENERATE_DESCRIPTIONS.filename })),
});

function normalizeOutputFormat(raw: string | undefined): MusicGenerationOutputFormat | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "mp3" || normalized === "wav") {
    return normalized;
  }
  throw new ToolInputError('format must be one of "mp3" or "wav"');
}

export function createMusicGenerateTool(options?: MediaGenerateToolOptions): AnyAgentTool | null {
  const context = resolveMediaGenerateToolContext("musicGenerationProviders", options, log);
  if (!context) {
    return null;
  }
  const { cfg, preparedProviders, sandboxConfig, taskOptions } = context;

  return {
    label: "Music Generation",
    name: "music_generate",
    displaySummary: "Generate music",
    description:
      "Create song/jingle/beat/loop/soundtrack/anthem/instrumental. Make/generate music => call; lyrics-only request => text only. prompt: style/genre/mood/tempo/instruments/purpose; lyrics: exact sung words; image/images condition on reference image(s). action=list discovers providers/models. Session chat background: call once/request; result returns as a later turn that sends the media. This turn: short ack at most, then end; no poll/yield. status checks active task.",
    parameters: MusicGenerateToolSchema,
    execute: createMediaGenerateExecute({
      options,
      list: (auth) => createMusicGenerateListActionResult(cfg, auth),
      status: createMusicGenerateStatusActionResult,
      generate: (args, signal) => {
        const model = readToolStringParam(args, "model");
        return prepareMediaGenerationTask({
          generationLabel: "music",
          cfg,
          args,
          model,
          options,
          signal,
          findDuplicate: createMusicGenerateDuplicateGuardResult,
          acquire: async (config) =>
            options?.preparedModelRuntime?.acquireMediaCapabilityProviders
              ? acquireMediaGenerationToolProviders("musicGenerationProviders", {
                  cfg: config,
                  prepared: options.preparedModelRuntime,
                })
              : undefined,
          resolveProviders: (acquired) =>
            acquired?.providers ?? (() => listRuntimeMusicGenerationProviders({ config: cfg })),
          prepare: async ({
            resources: acquired,
            modelConfig: musicGenerationModelConfig,
            effectiveCfg,
            prompt,
            explicitModelConfig,
          }) => {
            const providers = acquired?.providers ?? preparedProviders;

            const lyrics = readToolStringParam(args, "lyrics");
            const instrumental = readBooleanParam(args, "instrumental");
            const durationSeconds = readGenerationDurationSeconds(args);
            const format = normalizeOutputFormat(readToolStringParam(args, "format"));
            const filename = readToolStringParam(args, "filename");
            const timeout = normalizeMusicGenerationTimeoutMs(musicGenerationModelConfig.timeoutMs);
            const timeoutMs = timeout.timeoutMs;
            const imageInputs = normalizeMediaReferenceInputs({
              args,
              singularKey: "image",
              pluralKey: "images",
              maxCount: MAX_INPUT_IMAGES,
              label: "reference images",
            });
            const explicitModelRef = parseMusicGenerationModelRef(model);
            const primaryModelRef = parseMusicGenerationModelRef(
              musicGenerationModelConfig.primary,
            );
            const selectedModelRef = explicitModelRef ?? primaryModelRef;
            const shouldResolveSelectedProvider =
              imageInputs.length > 0 ||
              (model !== undefined && !explicitModelRef) ||
              (model === undefined && !primaryModelRef);
            const selectedProvider = shouldResolveSelectedProvider
              ? resolveSelectedCapabilityProvider({
                  providers:
                    providers ?? listRuntimeMusicGenerationProviders({ config: effectiveCfg }),
                  modelConfig: musicGenerationModelConfig,
                  modelOverride: model,
                })
              : undefined;
            const selectedProviderId = selectedProvider?.id ?? selectedModelRef?.provider;
            const requestKey = buildMediaGenerationRequestKey({
              tool: "music_generate",
              prompt,
              provider: selectedProviderId,
              model:
                model !== undefined
                  ? (explicitModelRef?.model ?? model)
                  : (primaryModelRef?.model ??
                    musicGenerationModelConfig.primary ??
                    selectedProvider?.defaultModel),
              lyrics,
              instrumental,
              durationSeconds,
              format,
              filename,
              imageInputs,
            });
            const duplicateGuardResult = await createMusicGenerateDuplicateGuardResult(
              options?.agentSessionKey,
              { prompt, requestKey, agentId: options?.requesterAgentId },
            );
            if (duplicateGuardResult) {
              return { kind: "result" as const, result: duplicateGuardResult };
            }
            signal?.throwIfAborted();
            acquired?.assertOpen();
            const remoteMediaSsrfPolicy = effectiveCfg.tools?.web?.fetch?.ssrfPolicy;
            const loadedReferenceImages = await loadMediaToolReferences({
              inputs: imageInputs,
              toolName: "music_generate",
              expectedKind: "image",
              maxBytes: resolveGeneratedMediaMaxBytes(effectiveCfg, "image"),
              workspaceDir: options?.workspaceDir,
              cwd: options?.cwd,
              fsPolicy: options?.fsPolicy,
              sandbox: sandboxConfig,
              ssrfPolicy: remoteMediaSsrfPolicy,
              signal,
              mapMedia: (media) => ({
                buffer: media.buffer,
                mimeType: "mimeType" in media ? media.mimeType : media.contentType,
                fileName: "fileName" in media ? media.fileName : undefined,
              }),
            });
            return {
              kind: "task" as const,
              params: {
                lifecycle: musicGenerationTaskLifecycle,
                ...taskOptions(),
                prompt,
                requestKey,
                providerId: selectedProviderId,

                messages: [timeout.message],
                detailExtras: {
                  ...buildMediaReferenceDetails(loadedReferenceImages, "image"),
                  ...(model ? { model } : {}),
                  ...(lyrics ? { requestedLyrics: lyrics } : {}),
                  ...(typeof instrumental === "boolean" ? { instrumental } : {}),
                  ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
                  ...(format ? { format } : {}),
                  ...(filename ? { filename } : {}),
                  timeoutMs,
                  ...(timeout.normalization
                    ? {
                        requestedTimeoutMs: timeout.normalization.requested,
                        timeoutNormalization: timeout.normalization,
                        warning: timeout.message,
                      }
                    : {}),
                },
                run: (taskHandle: MediaGenerationTaskHandle | null) =>
                  executeMusicGenerationJob({
                    request: {
                      cfg: effectiveCfg,
                      prompt,
                      agentDir: options?.agentDir,
                      modelOverride: model,
                      lyrics,
                      instrumental,
                      durationSeconds,
                      format,
                      inputImages: loadedReferenceImages.map((entry) => entry.source),
                      autoProviderFallback: explicitModelConfig ? false : undefined,
                      timeoutMs,
                    },
                    filename,
                    loadedReferenceImages,
                    taskHandle,
                    timeoutNormalization: timeout.normalization,
                    providers,
                  }),
              },
            };
          },
        });
      },
    }),
  };
}
