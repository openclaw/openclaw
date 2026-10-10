import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Command } from "commander";
import { createEnumOptionParser } from "../../shared/enum-option.js";
import { collectOption } from "../program/helpers.js";
import { isMissingMediaUnderstandingProvider } from "./media-understanding-result.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { formatEnvelopeForText, providerSummaryText } from "./output.js";
import { registerLocalProvidersCommand, runCapabilityCommand } from "./providers-command.js";

const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
const IMAGE_BACKGROUNDS = ["transparent", "opaque", "auto"] as const;
const IMAGE_QUALITIES = ["low", "medium", "high", "xhigh", "max", "auto"] as const;
const IMAGE_MODERATIONS = ["low", "auto"] as const;
const parseImageOption = createEnumOptionParser();

export function registerImageCapabilityCommands(capabilityCommand: Command): void {
  const imageCommand = capabilityCommand
    .command("image")
    .description("Image generation and description")
    .option("--agent <id>", "Agent whose model and auth state should be used");

  for (const [commandName, description] of [
    ["generate", "Generate images"],
    ["edit", "Edit images with one or more input files"],
  ] as const) {
    const generate = imageCommand.command(commandName).description(description);
    if (commandName === "edit") {
      generate.requiredOption("--file <path>", "Input file", collectOption);
    }
    generate
      .requiredOption("--prompt <text>", "Prompt text")
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
      .option("--json", "Output JSON", false)
      .action((opts, command) =>
        runCapabilityCommand(opts.json, formatEnvelopeForText, async () => {
          const capability: "image.generate" | "image.edit" = `image.${commandName}`;
          const prompt = String(opts.prompt);
          const file =
            commandName === "edit"
              ? Array.isArray(opts.file)
                ? (opts.file as string[])
                : [String(opts.file)]
              : undefined;
          const {
            resolveCapabilityAgentOption,
            parseOptionalPositiveInteger,
            parseOptionalTimeoutMs,
            requireProviderModelOverride,
            resolveLocalCapabilityAgent,
          } = await import("./shared.js");
          const agent = resolveCapabilityAgentOption(command, opts.agent);
          const model = opts.model as string | undefined;
          const count = parseOptionalPositiveInteger(opts.count, "--count");
          const size = opts.size as string | undefined;
          const aspectRatio = opts.aspectRatio as string | undefined;
          const resolution = opts.resolution as "1K" | "2K" | "4K" | undefined;
          const outputFormat = parseImageOption(
            opts.outputFormat,
            IMAGE_OUTPUT_FORMATS,
            "--output-format",
          );
          const background = parseImageOption(opts.background, IMAGE_BACKGROUNDS, "--background");
          const openaiBackground = parseImageOption(
            opts.openaiBackground,
            IMAGE_BACKGROUNDS,
            "--openai-background",
          );
          const openaiModeration = parseImageOption(
            opts.openaiModeration,
            IMAGE_MODERATIONS,
            "--openai-moderation",
          );
          const quality = parseImageOption(opts.quality, IMAGE_QUALITIES, "--quality");
          const timeoutMs = parseOptionalTimeoutMs(opts.timeoutMs as string | number | undefined);
          const output = opts.output as string | undefined;
          const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
          const { generateImage } = await import("../../image-generation/runtime.js");
          const { getImageMetadata } = await import("../../media/media-services.js");
          const { readInputFiles, writeOutputAsset } = await import("../media-output.js");
          requireProviderModelOverride(model);
          const { cfg, agentDir } = await resolveLocalCapabilityAgent({
            commandName: `infer ${capability}`,
            targetIds: getModelsCommandSecretTargetIds(),
            agent,
          });
          const inputImages =
            file && file.length > 0
              ? await Promise.all(
                  (await readInputFiles(file)).map(async (entry) => ({
                    buffer: entry.buffer,
                    fileName: path.basename(entry.path),
                    mimeType:
                      (await detectMime({ buffer: entry.buffer, filePath: entry.path })) ??
                      "image/png",
                  })),
                )
              : undefined;
          const result = await generateImage({
            cfg,
            agentDir,
            prompt,
            modelOverride: model,
            count,
            size,
            aspectRatio,
            resolution,
            quality,
            outputFormat,
            background,
            providerOptions:
              openaiBackground || openaiModeration
                ? {
                    openai: {
                      ...(openaiBackground ? { background: openaiBackground } : {}),
                      ...(openaiModeration ? { moderation: openaiModeration } : {}),
                    },
                  }
                : undefined,
            timeoutMs,
            inputImages,
          });
          const outputs = await Promise.all(
            result.images.map(async (image, index) => {
              const written = await writeOutputAsset({
                buffer: image.buffer,
                mimeType: image.mimeType,
                originalFilename: image.fileName,
                outputPath: output,
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
            capability,
            transport: "local" as const,
            provider: result.provider,
            model: result.model,
            attempts: result.attempts,
            outputs,
            ignoredOverrides: result.ignoredOverrides,
          } satisfies CapabilityEnvelope;
        }),
      );
  }

  for (const [commandName, description] of [
    ["describe", "Describe one image file"],
    ["describe-many", "Describe multiple image files"],
  ] as const) {
    const describe = imageCommand.command(commandName).description(description);
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
      .action((opts, command) =>
        runCapabilityCommand(opts.json, formatEnvelopeForText, async () => {
          const {
            parseOptionalTimeoutMs,
            resolveCapabilityAgentOption,
            requireProviderModelOverride,
            resolveLocalCapabilityAgent,
          } = await import("./shared.js");
          const capability: "image.describe" | "image.describe-many" = `image.${commandName}`;
          const files = multiple ? (opts.file as string[]) : [String(opts.file)];
          const requestedModel = opts.model as string | undefined;
          const promptInput = opts.prompt as string | undefined;
          const timeoutMs = parseOptionalTimeoutMs(opts.timeoutMs);
          const agent = resolveCapabilityAgentOption(command, opts.agent);
          const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
          const { runWithImageModelFallback } =
            await import("../../agents/model-fallback-image.js");
          const {
            describeImageFile,
            describePreparedImageWithModel,
            prepareImageDescriptionInput,
          } = await import("../../media-understanding/runtime.js");
          const { cfg, agentId, agentDir } = await resolveLocalCapabilityAgent({
            commandName: `infer ${capability}`,
            targetIds: getModelsCommandSecretTargetIds(),
            agent,
          });
          const activeModel = requireProviderModelOverride(requestedModel);
          const prompt = normalizeOptionalString(promptInput);
          const outputs = await Promise.all(
            files.map(async (filePath) => {
              const trimmed = filePath.trim();
              const resolvedPath = /^https?:\/\//i.test(trimmed) ? trimmed : path.resolve(filePath);
              const isRemoteUrl = /^https?:\/\//i.test(resolvedPath);
              const preparedImage = activeModel
                ? await prepareImageDescriptionInput({
                    filePath: resolvedPath,
                    ...(isRemoteUrl ? { mediaUrl: resolvedPath } : {}),
                    cfg,
                    timeoutMs,
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
                          timeoutMs,
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
                        timeoutMs,
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
            capability,
            transport: "local" as const,
            provider: outputs[0]?.provider,
            model: outputs[0]?.model,
            attempts: outputs.flatMap((output) => output.attempts),
            outputs: outputs.map(({ attempts: _attempts, ...output }) => output),
          } satisfies CapabilityEnvelope;
        }),
      );
  }

  registerLocalProvidersCommand(
    imageCommand,
    "List image generation providers",
    async (cfg, agentId) => {
      const { listGenerationProviders } = await import("./media-providers.js");
      return listGenerationProviders("image", cfg, agentId);
    },
    providerSummaryText,
  );
}
