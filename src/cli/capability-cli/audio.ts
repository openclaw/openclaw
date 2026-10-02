import path from "node:path";
import type { Command } from "commander";
import { isMissingMediaUnderstandingProvider } from "./media-understanding-result.js";
import type { CapabilityEnvelope } from "./metadata.js";
import { formatEnvelopeForText, providerSummaryText } from "./output.js";
import { registerLocalProvidersCommand, runCapabilityCommand } from "./providers-command.js";

async function runAudioTranscribe(params: {
  file: string;
  language?: string;
  model?: string;
  prompt?: string;
  agent?: string;
}) {
  const { requireProviderModelOverride, resolveLocalCapabilityAgent } = await import("./shared.js");
  const { getModelsCommandSecretTargetIds } = await import("../command-secret-targets.js");
  const { transcribeAudioFile } = await import("../../media-understanding/runtime.js");
  const { cfg, agentId, agentDir } = await resolveLocalCapabilityAgent({
    commandName: "infer audio transcribe",
    targetIds: getModelsCommandSecretTargetIds(),
    agent: params.agent,
  });
  const result = await transcribeAudioFile({
    agentDir,
    activeModel: requireProviderModelOverride(params.model),
    filePath: path.resolve(params.file),
    cfg,
    agentId,
    language: params.language,
    prompt: params.prompt,
  });
  if (!result.text) {
    if (isMissingMediaUnderstandingProvider(result)) {
      throw new Error(
        "No audio transcription provider is configured or ready. Configure an audio-capable tools.media.models entry, or pass --model <provider/model> after configuring that provider's auth/API key.",
      );
    }
    throw new Error(`No transcript returned for audio: ${path.resolve(params.file)}`);
  }
  return {
    ok: true,
    capability: "audio.transcribe",
    transport: "local" as const,
    provider: result.provider,
    model: result.model,
    attempts: [],
    outputs: [{ path: path.resolve(params.file), text: result.text, kind: "audio.transcription" }],
  } satisfies CapabilityEnvelope;
}

export function registerAudioCapabilityCommands(capability: Command): void {
  const audio = capability
    .command("audio")
    .description("Audio transcription")
    .option("--agent <id>", "Agent whose model and auth state should be used");

  audio
    .command("transcribe")
    .description("Transcribe one audio file")
    .requiredOption("--file <path>", "Audio file")
    .option("--agent <id>", "Agent whose model and auth state should be used")
    .option("--language <code>", "Language hint")
    .option("--prompt <text>", "Prompt hint")
    .option("--model <provider/model>", "Model override")
    .option("--json", "Output JSON", false)
    .action((opts, command) =>
      runCapabilityCommand(opts.json, formatEnvelopeForText, async () => {
        const { resolveCapabilityAgentOption } = await import("./shared.js");
        return runAudioTranscribe({
          file: String(opts.file),
          agent: resolveCapabilityAgentOption(command, opts.agent),
          language: opts.language as string | undefined,
          model: opts.model as string | undefined,
          prompt: opts.prompt as string | undefined,
        });
      }),
    );

  registerLocalProvidersCommand(
    audio,
    "List audio transcription providers",
    async (cfg, agentId) => {
      const { providerHasGenericConfig } = await import("./shared.js");
      const { inspectLocalAudioSelection } =
        await import("../../media-understanding/local-audio.js");
      const { buildMediaUnderstandingRegistry } =
        await import("../../media-understanding/provider-registry.js");
      const remoteProviders = [...buildMediaUnderstandingRegistry(undefined, cfg).values()]
        .filter((provider) => provider.capabilities?.includes("audio"))
        .map((provider) => ({
          available: true,
          configured: providerHasGenericConfig({
            cfg,
            providerId: provider.id,
            agentId,
          }),
          selected: false,
          id: provider.id,
          capabilities: provider.capabilities,
          defaultModels: provider.defaultModels,
        }));
      const localSelection = await inspectLocalAudioSelection();
      const localProviders = localSelection.candidates
        .filter((candidate) => candidate.available)
        .map((candidate) =>
          Object.assign(
            {
              available: candidate.available,
              configured: candidate.ready,
              selected: false,
              localFallbackSelected: candidate.selected,
              id: `local/${candidate.id}`,
              transport: "local-cli",
              command: candidate.command,
              observedBackend: candidate.observedBackend ?? "unknown",
              evidence: candidate.evidence,
            },
            candidate.capableBackend ? { capableBackend: candidate.capableBackend } : {},
            candidate.requestedBackend ? { requestedBackend: candidate.requestedBackend } : {},
            candidate.reason ? { reason: candidate.reason } : {},
          ),
        );
      return [...remoteProviders, ...localProviders];
    },
    providerSummaryText,
  );
}
