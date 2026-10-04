import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import type { Command } from "commander";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEnumOptionParser } from "../../shared/enum-option.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { formatEnvelopeForText } from "./output.js";
import { registerLocalProvidersCommand, runCapabilityCommand } from "./providers-command.js";

const GENERATED_VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

const parseVideoOption = createEnumOptionParser();
const VIDEO_RESOLUTIONS = ["360P", "480P", "540P", "720P", "768P", "1080P"] as const;

async function fetchGeneratedVideoDownload(params: {
  cfg: OpenClawConfig;
  provider: string;
  url: string;
}) {
  const { assertOkOrThrowHttpError, assertProviderBinaryResponseContent } =
    await import("../../agents/provider-http-errors.js");
  const {
    fetchWithTimeoutGuarded,
    resolveProviderHttpRequestConfig,
    sanitizeConfiguredModelProviderRequest,
  } = await import("../../plugin-sdk/provider-http.js");
  const providerConfig = params.cfg.models?.providers?.[params.provider];
  const { allowPrivateNetwork, dispatcherPolicy } = resolveProviderHttpRequestConfig({
    baseUrl: params.url,
    defaultBaseUrl: params.url,
    request: sanitizeConfiguredModelProviderRequest(providerConfig?.request),
    provider: params.provider,
    capability: "video",
    transport: "http",
  });
  const result = await fetchWithTimeoutGuarded(
    params.url,
    { method: "GET" },
    GENERATED_VIDEO_DOWNLOAD_TIMEOUT_MS,
    fetch,
    {
      ...(allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
      ...(dispatcherPolicy ? { dispatcherPolicy } : {}),
      auditContext: `${params.provider}-generated-video-download`,
    },
  );
  try {
    await assertOkOrThrowHttpError(
      result.response,
      `${params.provider} generated video download failed`,
    );
    assertProviderBinaryResponseContent(
      result.response,
      `${params.provider} generated video download`,
      "video",
    );
    return result;
  } catch (error) {
    await result.release();
    throw error;
  }
}

export function registerVideoCapabilityCommands(capability: Command): void {
  const videoCommand = capability
    .command("video")
    .description("Video generation and description")
    .option("--agent <id>", "Agent whose model and auth state should be used");

  videoCommand
    .command("generate")
    .description("Generate video")
    .requiredOption("--prompt <text>", "Prompt text")
    .option("--model <provider/model>", "Model override")
    .option("--size <size>", "Size hint like 1280x720")
    .option("--aspect-ratio <ratio>", "Aspect ratio hint like 16:9")
    .option("--resolution <value>", "Resolution hint: 360P, 480P, 540P, 720P, 768P, or 1080P")
    .option("--duration <seconds>", "Target duration in seconds")
    .option("--audio", "Enable generated audio when supported")
    .option("--watermark", "Request provider watermark when supported")
    .option("--timeout-ms <ms>", "Provider request timeout in milliseconds")
    .option("--output <path>", "Output path")
    .option(
      "--agent <id>",
      "Agent whose saved provider auth is used (default: agents.defaults.systemAgent.agentId, then the sole agent)",
    )
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, formatEnvelopeForText, async () => {
        const {
          parseOptionalFiniteNumber,
          parseOptionalTimeoutMs,
          resolveCapabilityAgentOption,
          requireProviderModelOverride,
          resolveLocalCapabilityAgent,
        } = await import("./shared.js");
        const prompt = String(opts.prompt);
        const agent = resolveCapabilityAgentOption(command, opts.agent);
        const model = opts.model as string | undefined;
        const output = opts.output as string | undefined;
        const resolution = parseVideoOption(opts.resolution, VIDEO_RESOLUTIONS, "video resolution");
        const durationSeconds = parseOptionalFiniteNumber(opts.duration, "--duration");
        const timeoutMs = parseOptionalTimeoutMs(opts.timeoutMs);
        const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
        const { generateVideo } = await import("../../video-generation/runtime.js");
        const { readResponseWithLimit } = await import("../../infra/http-body.js");
        const { resolveGeneratedMediaMaxBytes } =
          await import("../../media/configured-max-bytes.js");
        const { publishOutputFileAtomically, writeOutputAsset } =
          await import("../media-output.js");
        requireProviderModelOverride(model);
        const { cfg, agentDir } = await resolveLocalCapabilityAgent({
          commandName: "infer video.generate",
          targetIds: getModelsCommandSecretTargetIds(),
          agent,
        });
        const result = await generateVideo({
          cfg,
          agentDir,
          prompt,
          modelOverride: model,
          size: opts.size as string | undefined,
          aspectRatio: opts.aspectRatio as string | undefined,
          resolution,
          durationSeconds,
          audio: opts.audio === true ? true : undefined,
          watermark: opts.watermark === true ? true : undefined,
          timeoutMs,
        });
        const outputs = await Promise.all(
          result.videos.map(async (video, index) => {
            if (!video.buffer && !video.url) {
              throw new Error(`Video asset at index ${index} has neither buffer nor url`);
            }

            let videoBuffer = video.buffer;
            if (!videoBuffer && video.url) {
              const download = await fetchGeneratedVideoDownload({
                cfg,
                provider: result.provider,
                url: video.url,
              });
              const response = download.response;
              try {
                if (output && response.body) {
                  const mimeType = normalizeMimeType(video.mimeType);
                  const ext =
                    extensionForMime(mimeType) ||
                    path.extname(video.fileName ?? "") ||
                    path.extname(output);
                  const resolvedOutput = path.resolve(output);
                  const parsed = path.parse(resolvedOutput);
                  const filePath =
                    result.videos.length <= 1
                      ? path.join(parsed.dir, `${parsed.name}${ext}`)
                      : path.join(parsed.dir, `${parsed.name}-${String(index + 1)}${ext}`);
                  const size = await publishOutputFileAtomically({
                    filePath,
                    writeTemp: async (tempPath) => {
                      await pipeline(
                        Readable.fromWeb(
                          response.body as import("node:stream/web").ReadableStream<Uint8Array>,
                        ),
                        createWriteStream(tempPath, { flags: "wx" }),
                      );
                      const writtenSize = (await fs.stat(tempPath)).size;
                      if (writtenSize === 0) {
                        throw new Error("Generated media output is empty.");
                      }
                      return writtenSize;
                    },
                  });
                  return { path: filePath, mimeType: video.mimeType, size };
                }
                // Bound the in-memory download; --output streams to disk. Keep signed
                // provider URLs out of overflow errors.
                const videoMaxBytes = resolveGeneratedMediaMaxBytes(cfg, "video");
                videoBuffer = await readResponseWithLimit(response, videoMaxBytes, {
                  onOverflow: ({ maxBytes }) =>
                    new Error(
                      `${result.provider} generated video download exceeds ${maxBytes} bytes; pass --output to stream large videos to disk`,
                    ),
                });
                if (videoBuffer.byteLength === 0) {
                  throw new Error("Generated media output is empty.");
                }
              } finally {
                await download.release();
              }
            }

            return await writeOutputAsset({
              buffer: videoBuffer!,
              mimeType: video.mimeType,
              originalFilename: video.fileName,
              outputPath: output,
              outputIndex: index,
              outputCount: result.videos.length,
              subdir: "generated",
            });
          }),
        );
        return {
          ok: true,
          capability: "video.generate",
          transport: "local" as const,
          provider: result.provider,
          model: result.model,
          attempts: result.attempts,
          outputs,
        } satisfies CapabilityEnvelope;
      }),
    );

  videoCommand
    .command("describe")
    .description("Describe one video file")
    .requiredOption("--file <path>", "Video file")
    .option("--agent <id>", "Agent whose model and auth state should be used")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, formatEnvelopeForText, async () => {
        const {
          requireProviderModelOverride,
          resolveLocalCapabilityAgent,
          resolveCapabilityAgentOption,
        } = await import("./shared.js");
        const file = String(opts.file);
        const agent = resolveCapabilityAgentOption(command, opts.agent);
        const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
        const { describeVideoFile } = await import("../../media-understanding/runtime.js");
        const { cfg, agentId, agentDir } = await resolveLocalCapabilityAgent({
          commandName: "infer video.describe",
          targetIds: getModelsCommandSecretTargetIds(),
          agent,
          surface: "infer video describe",
        });
        const activeModel = requireProviderModelOverride(opts.model as string | undefined);
        const result = await describeVideoFile({
          filePath: path.resolve(file),
          cfg,
          agentId,
          agentDir,
          activeModel,
        });
        if (!result.text) {
          throw new Error(`No description returned for video: ${path.resolve(file)}`);
        }
        return {
          ok: true,
          capability: "video.describe",
          transport: "local" as const,
          provider: result.provider,
          model: result.model,
          attempts: [],
          outputs: [{ path: path.resolve(file), text: result.text, kind: "video.description" }],
        } satisfies CapabilityEnvelope;
      }),
    );

  registerLocalProvidersCommand(
    videoCommand,
    "List video generation and description providers",
    async (cfg, agentId) => {
      const { providerHasGenericConfig, resolveSelectedProviderFromModelRef } =
        await import("./shared.js");
      const { listRuntimeVideoGenerationProviders } =
        await import("../../video-generation/runtime.js");
      const { buildMediaUnderstandingRegistry } =
        await import("../../media-understanding/provider-registry.js");
      const selectedGenerationProvider = resolveSelectedProviderFromModelRef(
        resolveAgentModelPrimaryValue(cfg.agents?.defaults?.mediaModels?.video),
      );
      return {
        generation: listRuntimeVideoGenerationProviders({ config: cfg }).map((provider) => ({
          available: true,
          configured:
            selectedGenerationProvider === provider.id ||
            providerHasGenericConfig({ cfg, providerId: provider.id, agentId }),
          selected: selectedGenerationProvider === provider.id,
          id: provider.id,
          label: provider.label,
          defaultModel: provider.defaultModel,
          models: provider.models ?? [],
          capabilities: provider.capabilities,
        })),
        description: [...buildMediaUnderstandingRegistry(undefined, cfg).values()]
          .filter((provider) => provider.capabilities?.includes("video"))
          .map((provider) => ({
            available: true,
            configured: providerHasGenericConfig({ cfg, providerId: provider.id, agentId }),
            selected: false,
            id: provider.id,
            capabilities: provider.capabilities,
            defaultModels: provider.defaultModels,
          })),
      };
    },
  );
}
