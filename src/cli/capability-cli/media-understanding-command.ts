import path from "node:path";
import type { Command } from "commander";
import { isMissingMediaUnderstandingProvider } from "./media-understanding-result.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { formatEnvelopeForText } from "./output.js";
import { runCapabilityCommand } from "./providers-command.js";

type MediaUnderstandingOptions = {
  file: string;
  agent?: string;
  model?: string;
  language?: string;
  prompt?: string;
  json: boolean;
};

export function registerMediaUnderstandingCommand(parent: Command, kind: "audio" | "video") {
  const audio = kind === "audio";
  const command = parent
    .command(audio ? "transcribe" : "describe")
    .description(audio ? "Transcribe one audio file" : "Describe one video file")
    .requiredOption("--file <path>", audio ? "Audio file" : "Video file")
    .option("--agent <id>", "Agent whose model and auth state should be used");
  if (audio) {
    command.option("--language <code>", "Language hint").option("--prompt <text>", "Prompt hint");
  }
  command
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action((opts: MediaUnderstandingOptions, actionCommand: Command) =>
      runCapabilityCommand(opts.json, formatEnvelopeForText, async () => {
        const {
          requireProviderModelOverride,
          resolveLocalCapabilityAgent,
          resolveCapabilityAgentOption,
        } = await import("./shared.js");
        const file = opts.file;
        const agent = resolveCapabilityAgentOption(actionCommand, opts.agent);
        const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
        const { transcribeAudioFile, describeVideoFile } =
          await import("../../media-understanding/runtime.js");
        const { cfg, agentId, agentDir } = await resolveLocalCapabilityAgent({
          commandName: audio ? "infer audio transcribe" : "infer video.describe",
          targetIds: getModelsCommandSecretTargetIds(),
          agent,
          ...(audio ? {} : { surface: "infer video describe" }),
        });
        const activeModel = requireProviderModelOverride(opts.model);
        const input = { filePath: path.resolve(file), cfg, agentId, agentDir, activeModel };
        const result = audio
          ? await transcribeAudioFile({
              ...input,
              language: opts.language,
              prompt: opts.prompt,
            })
          : await describeVideoFile(input);
        if (!result.text) {
          if (audio && isMissingMediaUnderstandingProvider(result)) {
            throw new Error(
              "No audio transcription provider is configured or ready. Configure an audio-capable tools.media.models entry, or pass --model <provider/model> after configuring that provider's auth/API key.",
            );
          }
          throw new Error(
            `No ${audio ? "transcript" : "description"} returned for ${kind}: ${path.resolve(file)}`,
          );
        }
        return {
          ok: true,
          capability: audio ? "audio.transcribe" : "video.describe",
          transport: "local" as const,
          provider: result.provider,
          model: result.model,
          attempts: [],
          outputs: [
            {
              path: path.resolve(file),
              text: result.text,
              kind: audio ? "audio.transcription" : "video.description",
            },
          ],
        } satisfies CapabilityEnvelope;
      }),
    );
}
