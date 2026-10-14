/**
 * Contract suite for bundled plugin registration ownership and manifest auth metadata.
 */
import { describe, expect, it } from "vitest";
import { loadPluginManifestRegistryCore } from "../../plugins/manifest-registry.js";

export type PluginRegistrationContractParams = {
  pluginId: string;
  cliBackendIds?: string[];
  providerIds?: string[];
  webFetchProviderIds?: string[];
  webSearchProviderIds?: string[];
  speechProviderIds?: string[];
  realtimeTranscriptionProviderIds?: string[];
  realtimeVoiceProviderIds?: string[];
  mediaUnderstandingProviderIds?: string[];
  transcriptSourceProviderIds?: string[];
  imageGenerationProviderIds?: string[];
  videoGenerationProviderIds?: string[];
  musicGenerationProviderIds?: string[];
  toolNames?: string[];
  manifestAuthChoice?: {
    pluginId: string;
    choiceId: string;
    choiceLabel: string;
    groupId: string;
    groupLabel: string;
    groupHint: string;
  };
};

export type PluginRegistrationContractResolver = (
  pluginId: string,
) => Omit<PluginRegistrationContractParams, "manifestAuthChoice"> | undefined;

/** Installs tests that pin a bundled plugin's registered provider/tool ownership. */
export function installPluginRegistrationContract(
  params: PluginRegistrationContractParams,
  resolveRegistration: PluginRegistrationContractResolver,
) {
  const findRegistration = (pluginId: string) => {
    const entry = resolveRegistration(pluginId);
    if (!entry) {
      throw new Error(`plugin registration contract missing for ${pluginId}`);
    }
    return entry;
  };

  describe(`${params.pluginId} plugin registration contract`, () => {
    for (const [key, label] of [
      ["cliBackendIds", "cli-backend"],
      ["providerIds", "provider"],
      ["webSearchProviderIds", "web search"],
      ["webFetchProviderIds", "web fetch"],
      ["speechProviderIds", "speech"],
      ["realtimeTranscriptionProviderIds", "realtime-transcription"],
      ["realtimeVoiceProviderIds", "realtime-voice"],
      ["mediaUnderstandingProviderIds", "media-understanding"],
      ["transcriptSourceProviderIds", "transcripts source"],
      ["imageGenerationProviderIds", "image-generation"],
      ["videoGenerationProviderIds", "video-generation"],
      ["musicGenerationProviderIds", "music-generation"],
      ["toolNames", "tool"],
    ] as const) {
      if (params[key]) {
        it(`keeps bundled ${label} ownership explicit`, () => {
          expect(findRegistration(params.pluginId)[key]).toEqual(params[key]);
        });
      }
    }

    const manifestAuthChoice = params.manifestAuthChoice;
    if (manifestAuthChoice) {
      it("keeps onboarding auth grouping explicit", () => {
        const plugin = loadPluginManifestRegistryCore({}).plugins.find(
          (entry) => entry.origin === "bundled" && entry.id === manifestAuthChoice.pluginId,
        );

        expect(plugin?.providerAuthChoices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              choiceId: manifestAuthChoice.choiceId,
              choiceLabel: manifestAuthChoice.choiceLabel,
              groupId: manifestAuthChoice.groupId,
              groupLabel: manifestAuthChoice.groupLabel,
              groupHint: manifestAuthChoice.groupHint,
            }),
          ]),
        );
      });
    }
  });
}
