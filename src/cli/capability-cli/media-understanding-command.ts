import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
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

async function resolveMediaFilePath(file: string): Promise<string> {
  if (process.platform === "win32" || !file.split("/").includes("..")) {
    return path.resolve(file);
  }
  const name = path.basename(file);
  if (file.endsWith("/") || name === "." || name === "..") {
    throw new Error(`Expected a regular media file: ${file}`);
  }
  // Resolve symlinks before parent segments, but leave the final link for the media root check.
  return path.join(await fs.realpath(path.dirname(file)), name);
}

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
        const filePath = await resolveMediaFilePath(file);
        const input = { filePath, cfg, agentId, agentDir, activeModel };
        const signal = getAsyncWorkSignal();
        const result = audio
          ? await transcribeAudioFile(
              {
                ...input,
                language: opts.language,
                prompt: opts.prompt,
              },
              signal ? { signal, assertCurrent: () => signal.throwIfAborted() } : undefined,
            )
          : await describeVideoFile(input);
        if (!result.text) {
          if (audio && isMissingMediaUnderstandingProvider(result)) {
            throw new Error(
              "No audio transcription provider is configured or ready. Configure an audio-capable tools.media.models entry, or pass --model <provider/model> after configuring that provider's auth/API key.",
            );
          }
          throw new Error(
            `No ${audio ? "transcript" : "description"} returned for ${kind}: ${filePath}`,
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
              path: filePath,
              text: result.text,
              kind: audio ? "audio.transcription" : "video.description",
            },
          ],
        } satisfies CapabilityEnvelope;
      }),
    );
}
