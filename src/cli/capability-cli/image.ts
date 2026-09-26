import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type {
  ImageGenerationBackground,
  ImageGenerationOpenAIModeration,
  ImageGenerationOutputFormat,
  ImageGenerationQuality,
} from "../../image-generation/types.js";
import { defaultRuntime } from "../../runtime.js";
import { createEnumOptionParser } from "../../shared/enum-option.js";
import { runCommandWithRuntime } from "../cli-utils.js";
import { collectOption } from "../program/helpers.js";
import { isMissingMediaUnderstandingProvider } from "./media-understanding-result.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { emitJsonOrText, formatEnvelopeForText, providerSummaryText } from "./output.js";
import { registerLocalProvidersCommand } from "./providers-command.js";

const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
const IMAGE_MODERATIONS = ["low", "auto"] as const;
const parseImageOption = createEnumOptionParser();

async function runImageGenerate(params: {
  capability: "image.generate" | "image.edit";
  prompt: string;
  model?: string;
  count?: number;
  size?: string;
  aspectRatio?: string;
  resolution?: "1K" | "2K" | "4K";
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  openaiBackground?: ImageGenerationBackground;
  openaiModeration?: ImageGenerationOpenAIModeration;
  quality?: ImageGenerationQuality;
  file?: string[];
  output?: string;
  timeoutMs?: number;
  agent?: string;
}) {
  const {
    requireProviderModelOverride,
    resolveCapabilityProviderAgentId,
    resolveLocalCapabilityRuntimeConfig,
  } = await import("./shared.js");
  const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
  const { resolveAgentDir } = await import("../../agents/agent-scope.js");
  const { generateImage } = await import("../../image-generation/runtime.js");
  const { getImageMetadata } = await import("../../media/media-services.js");
  const { readInputFiles, writeOutputAsset } = await import("../media-output.js");
  requireProviderModelOverride(params.model);
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: `infer ${params.capability}`,
    targetIds: getModelsCommandSecretTargetIds(),
  });
  const agentId = resolveCapabilityProviderAgentId(cfg, params.agent, `infer ${params.capability}`);
  const { prepareLocalCapabilityAccountSecrets } = await import("./local-account-secrets.js");
  await prepareLocalCapabilityAccountSecrets({ cfg, agentId });
  const agentDir = resolveAgentDir(cfg, agentId);
  const inputImages =
    params.file && params.file.length > 0
      ? await Promise.all(
          (await readInputFiles(params.file)).map(async (entry) => ({
            buffer: entry.buffer,
            fileName: path.basename(entry.path),
            mimeType:
              (await detectMime({ buffer: entry.buffer, filePath: entry.path })) ?? "image/png",
          })),
        )
      : undefined;
  const result = await generateImage({
    cfg,
    agentDir,
    prompt: params.prompt,
    modelOverride: params.model,
    count: params.count,
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    quality: params.quality,
    outputFormat: params.outputFormat,
    background: params.background,
    providerOptions:
      params.openaiBackground || params.openaiModeration
        ? {
            openai: {
              ...(params.openaiBackground ? { background: params.openaiBackground } : {}),
              ...(params.openaiModeration ? { moderation: params.openaiModeration } : {}),
            },
          }
        : undefined,
    timeoutMs: params.timeoutMs,
    inputImages,
  });
  const outputs = await Promise.all(
    result.images.map(async (image, index) => {
      const written = await writeOutputAsset({
        buffer: image.buffer,
        mimeType: image.mimeType,
        originalFilename: image.fileName,
        outputPath: params.output,
        outputIndex: index,
        outputCount: result.images.length,
        subdir: "generated",
      });
      const metadata = await getImageMetadata(image.buffer).catch(() => undefined);
      return {
        ...written,
        width: metadata?.width,
        height: metadata?.height,
        revisedPrompt: image.revisedPrompt,
      };
    }),
  );
  return {
    ok: true,
    capability: params.capability,
    transport: "local" as const,
    provider: result.provider,
    model: result.model,
    attempts: result.attempts,
    outputs,
    ignoredOverrides: result.ignoredOverrides,
  } satisfies CapabilityEnvelope;
}

async function runImageDescribe(params: {
  capability: "image.describe" | "image.describe-many";
  files: string[];
  model?: string;
  prompt?: string;
  timeoutMs?: number;
  agent?: string;
}) {
  const {
    requireProviderModelOverride,
    resolveCapabilityProviderAgentId,
    resolveLocalCapabilityRuntimeConfig,
  } = await import("./shared.js");
  const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
  const { resolveAgentDir } = await import("../../agents/agent-scope.js");
  const { runWithImageModelFallback } = await import("../../agents/model-fallback-image.js");
  const { describeImageFile, describePreparedImageWithModel, prepareImageDescriptionInput } =
    await import("../../media-understanding/runtime.js");
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: `infer ${params.capability}`,
    targetIds: getModelsCommandSecretTargetIds(),
  });
  const agentId = resolveCapabilityProviderAgentId(cfg, params.agent, `infer ${params.capability}`);
  const { prepareLocalCapabilityAccountSecrets } = await import("./local-account-secrets.js");
  await prepareLocalCapabilityAccountSecrets({ cfg, agentId });
  const agentDir = resolveAgentDir(cfg, agentId);
  const activeModel = requireProviderModelOverride(params.model);
  const prompt = normalizeOptionalString(params.prompt);
  const outputs = await Promise.all(
    params.files.map(async (filePath) => {
      const resolvedPath = resolveImageDescribeInput(filePath);
      const isRemoteUrl = /^https?:\/\//i.test(resolvedPath);
      const preparedImage = activeModel
        ? await prepareImageDescriptionInput({
            filePath: resolvedPath,
            ...(isRemoteUrl ? { mediaUrl: resolvedPath } : {}),
            cfg,
            timeoutMs: params.timeoutMs,
          })
        : undefined;
      const result =
        activeModel && preparedImage
          ? await runWithImageModelFallback({
              cfg,
              modelOverride: `${activeModel.provider}/${activeModel.model}`,
              run: async (provider, model) => {
                const described = await describePreparedImageWithModel({
                  image: preparedImage,
                  cfg,
                  agentId,
                  agentDir,
                  provider,
                  model,
                  prompt: prompt ?? "Describe the image.",
                  timeoutMs: params.timeoutMs,
                });
                if (!described.text?.trim()) {
                  throw new Error(`No description returned for image: ${resolvedPath}`);
                }
                return described;
              },
            })
          : {
              result: await describeImageFile({
                filePath: resolvedPath,
                ...(isRemoteUrl ? { mediaUrl: resolvedPath } : {}),
                cfg,
                agentId,
                agentDir,
                prompt,
                timeoutMs: params.timeoutMs,
              }),
              provider: undefined,
              model: undefined,
              attempts: [],
            };
      if (!result.result.text) {
        if (isMissingMediaUnderstandingProvider(result.result)) {
          throw new Error(
            "No image understanding provider is configured or ready. Configure an image-capable tools.media.models entry or agents.defaults.imageModel.primary, or pass --model <provider/model> after configuring that provider's auth/API key.",
          );
        }
        throw new Error(`No description returned for image: ${resolvedPath}`);
      }
      return {
        path: resolvedPath,
        text: result.result.text,
        provider: result.provider ?? result.result.provider,
        model: result.result.model ?? result.model,
        attempts: result.attempts,
        kind: "image.description",
      };
    }),
  );
  return {
    ok: true,
    capability: params.capability,
    transport: "local" as const,
    provider: outputs[0]?.provider,
    model: outputs[0]?.model,
    attempts: outputs.flatMap((output) => output.attempts),
    outputs: outputs.map(({ attempts: _attempts, ...output }) => output),
  } satisfies CapabilityEnvelope;
}

function resolveImageDescribeInput(filePath: string): string {
  const trimmed = filePath.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : path.resolve(filePath);
}

function addImageGenerationOptions(command: Command): Command {
  return command
    .option("--model <provider/model>", "Model override")
    .option("--count <n>", "Number of images")
    .option("--size <size>", "Size hint like 1024x1024")
    .option("--aspect-ratio <ratio>", "Aspect ratio hint like 16:9")
    .option("--resolution <value>", "Resolution hint: 1K, 2K, or 4K")
    .option("--output-format <format>", "Output format hint: png, jpeg, or webp")
    .option("--background <value>", "Background hint: transparent, opaque, or auto")
    .option("--openai-background <value>", "OpenAI background hint: transparent, opaque, or auto")
    .option("--openai-moderation <value>", "OpenAI moderation hint: low or auto")
    .option("--quality <value>", "Quality hint: low, medium, high, xhigh, max, or auto")
    .option("--timeout-ms <ms>", "Provider request timeout in milliseconds")
    .option("--output <path>", "Output path")
    .option(
      "--agent <id>",
      "Agent whose saved provider auth is used (default: agents.defaults.systemAgent.agentId, then the sole agent)",
    )
    .option("--json", "Output JSON", false);
}

async function resolveImageGenerationOptions(opts: Record<string, unknown>, command: Command) {
  const { resolveCapabilityAgentOption, parseOptionalPositiveInteger, parseOptionalTimeoutMs } =
    await import("./shared.js");
  return {
    agent: resolveCapabilityAgentOption(command, opts.agent),
    model: opts.model as string | undefined,
    count: parseOptionalPositiveInteger(opts.count, "--count"),
    size: opts.size as string | undefined,
    aspectRatio: opts.aspectRatio as string | undefined,
    resolution: opts.resolution as "1K" | "2K" | "4K" | undefined,
    outputFormat: parseImageOption(opts.outputFormat, IMAGE_OUTPUT_FORMATS, "--output-format"),
    background: parseImageOption(opts.background, IMAGE_BACKGROUNDS, "--background"),
    openaiBackground: parseImageOption(
      opts.openaiBackground,
      IMAGE_BACKGROUNDS,
      "--openai-background",
    ),
    openaiModeration: parseImageOption(
      opts.openaiModeration,
      IMAGE_MODERATIONS,
      "--openai-moderation",
    ),
    quality: parseImageOption(opts.quality, IMAGE_QUALITIES, "--quality"),
    timeoutMs: parseOptionalTimeoutMs(opts.timeoutMs as string | number | undefined),
    output: opts.output as string | undefined,
  };
}

export function registerImageCapabilityCommands(capability: Command): void {
  const image = capability
    .command("image")
    .description("Image generation and description")
    .option("--agent <id>", "Agent whose model and auth state should be used");

  for (const [commandName, description] of [
    ["generate", "Generate images"],
    ["edit", "Edit images with one or more input files"],
  ] as const) {
    const generate = image.command(commandName).description(description);
    if (commandName === "edit") {
      generate.requiredOption("--file <path>", "Input file", collectOption);
    }
    addImageGenerationOptions(generate.requiredOption("--prompt <text>", "Prompt text")).action(
      async (opts, command) => {
        await runCommandWithRuntime(defaultRuntime, async () => {
          const result = await runImageGenerate({
            capability: `image.${commandName}`,
            prompt: String(opts.prompt),
            ...(commandName === "edit"
              ? { file: Array.isArray(opts.file) ? (opts.file as string[]) : [String(opts.file)] }
              : {}),
            ...(await resolveImageGenerationOptions(opts, command)),
          });
          emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
        });
      },
    );
  }

  for (const [commandName, description] of [
    ["describe", "Describe one image file"],
    ["describe-many", "Describe multiple image files"],
  ] as const) {
    const describe = image.command(commandName).description(description);
    const multiple = commandName === "describe-many";
    if (multiple) {
      describe.requiredOption("--file <path>", "Image file", collectOption);
    } else {
      describe.requiredOption("--file <path>", "Image file");
    }
    describe
      .option("--prompt <text>", "Prompt hint")
      .option("--model <provider/model>", "Model override")
      .option("--timeout-ms <ms>", "Provider request timeout in milliseconds")
      .option(
        "--agent <id>",
        "Agent whose saved provider auth is used (default: agents.defaults.systemAgent.agentId, then the sole agent)",
      )
      .option("--json", "Output JSON", false)
      .action(async (opts, command) => {
        await runCommandWithRuntime(defaultRuntime, async () => {
          const { parseOptionalTimeoutMs, resolveCapabilityAgentOption } =
            await import("./shared.js");
          const result = await runImageDescribe({
            capability: `image.${commandName}`,
            files: multiple ? (opts.file as string[]) : [String(opts.file)],
            model: opts.model as string | undefined,
            prompt: opts.prompt as string | undefined,
            timeoutMs: parseOptionalTimeoutMs(opts.timeoutMs),
            agent: resolveCapabilityAgentOption(command, opts.agent),
          });
          emitJsonOrText(defaultRuntime, Boolean(opts.json), result, formatEnvelopeForText);
        });
      });
  }

  registerLocalProvidersCommand(
    image,
    "List image generation providers",
    async (cfg, agentId) => {
      const { providerHasGenericConfig, resolveSelectedProviderFromModelRef } =
        await import("./shared.js");
      const { listRuntimeImageGenerationProviders } =
        await import("../../image-generation/runtime.js");
      const selectedProvider = resolveSelectedProviderFromModelRef(
        resolveAgentModelPrimaryValue(cfg.agents?.defaults?.mediaModels?.image),
      );
      return listRuntimeImageGenerationProviders({ config: cfg }).map((provider) => ({
        available: true,
        configured:
          selectedProvider === provider.id ||
          providerHasGenericConfig({ cfg, providerId: provider.id, agentId }),
        selected: selectedProvider === provider.id,
        id: provider.id,
        label: provider.label,
        defaultModel: provider.defaultModel,
        models: provider.models ?? [],
        capabilities: provider.capabilities,
      }));
    },
    providerSummaryText,
  );
}
