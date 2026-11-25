import type { Command } from "commander";
import { registerMediaUnderstandingCommand } from "./media-understanding-command.js";
import { providerSummaryText } from "./output.js";
import { registerLocalProvidersCommand } from "./providers-command.js";

export function registerAudioCapabilityCommands(capability: Command): void {
  const audio = capability
    .command("audio")
    .description("Audio transcription")
    .option("--agent <id>", "Agent whose model and auth state should be used");

  registerMediaUnderstandingCommand(audio, "audio");

  registerLocalProvidersCommand(
    audio,
    "List audio transcription providers",
    async (cfg, agentId) => {
      const { inspectLocalAudioSelection } =
        await import("../../media-understanding/local-audio.js");
      const { listUnderstandingProviders } = await import("./media-providers.js");
      const remoteProviders = await listUnderstandingProviders("audio", cfg, agentId);
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
