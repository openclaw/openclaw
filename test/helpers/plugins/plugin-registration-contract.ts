import { describe, expect, it } from "vitest";
import {
  imageGenerationProviderContractRegistry,
  mediaUnderstandingProviderContractRegistry,
  pluginRegistrationContractRegistry,
  speechProviderContractRegistry,
  videoGenerationProviderContractRegistry,
} from "../../../src/plugins/contracts/registry.js";
import { loadPluginManifestRegistry } from "../../../src/plugins/manifest-registry.js";

type PluginRegistrationContractParams = {
  pluginId: string;
  providerIds?: string[];
  webFetchProviderIds?: string[];
  webSearchProviderIds?: string[];
  speechProviderIds?: string[];
  realtimeTranscriptionProviderIds?: string[];
  realtimeVoiceProviderIds?: string[];
  mediaUnderstandingProviderIds?: string[];
  imageGenerationProviderIds?: string[];
  videoGenerationProviderIds?: string[];
  toolNames?: string[];
  requireSpeechVoices?: boolean;
  requireDescribeImages?: boolean;
  requireGenerateImage?: boolean;
  requireGenerateVideo?: boolean;
  manifestAuthChoice?: {
    pluginId: string;
    choiceId: string;
    choiceLabel: string;
    groupId: string;
    groupLabel: string;
    groupHint: string;
  };
};

function findRegistration(pluginId: string) {
  const entry = pluginRegistrationContractRegistry.find(
    (candidate) => candidate.pluginId === pluginId,
  );
  if (!entry) {
    throw new Error(`plugin registration contract missing for ${pluginId}`);
  }
  return entry;
}

function findSpeechProviderIds(pluginId: string) {
  return speechProviderContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findSpeechProvider(pluginId: string) {
  const entry = speechProviderContractRegistry.find((candidate) => candidate.pluginId === pluginId);
  if (!entry) {
    throw new Error(`speech provider contract missing for ${pluginId}`);
  }
  return entry.provider;
}

function findMediaUnderstandingProviderIds(pluginId: string) {
  return mediaUnderstandingProviderContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findMediaUnderstandingProvider(pluginId: string) {
  const entry = mediaUnderstandingProviderContractRegistry.find(
    (candidate) => candidate.pluginId === pluginId,
  );
  if (!entry) {
    throw new Error(`media-understanding provider contract missing for ${pluginId}`);
  }
  return entry.provider;
}

function findImageGenerationProviderIds(pluginId: string) {
  return imageGenerationProviderContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findImageGenerationProvider(pluginId: string) {
  const entry = imageGenerationProviderContractRegistry.find(
    (candidate) => candidate.pluginId === pluginId,
  );
  if (!entry) {
    throw new Error(`image-generation provider contract missing for ${pluginId}`);
  }
  return entry.provider;
}

function findVideoGenerationProviderIds(pluginId: string) {
  return videoGenerationProviderContractRegistry
    .filter((entry) => entry.pluginId === pluginId)
    .map((entry) => entry.provider.id)
    .toSorted((left, right) => left.localeCompare(right));
}

function findVideoGenerationProvider(pluginId: string) {
  const entry = videoGenerationProviderContractRegistry.find(
    (candidate) => candidate.pluginId === pluginId,
  );
  if (!entry) {
    throw new Error(`video-generation provider contract missing for ${pluginId}`);
  }
  return entry.provider;
}

export function describePluginRegistrationContract(params: PluginRegistrationContractParams) {
  describe(`${params.pluginId} plugin registration contract`, () => {
    if (params.providerIds) {
      it("keeps bundled provider ownership explicit", () => {
        expect(findRegistration(params.pluginId).providerIds).toEqual(params.providerIds);
      });
    }

    if (params.webSearchProviderIds) {
      it("keeps bundled web search ownership explicit", () => {
        expect(findRegistration(params.pluginId).webSearchProviderIds).toEqual(
          params.webSearchProviderIds,
        );
      });
    }

    if (params.webFetchProviderIds) {
      it("keeps bundled web fetch ownership explicit", () => {
        expect(findRegistration(params.pluginId).webFetchProviderIds).toEqual(
          params.webFetchProviderIds,
        );
      });
    }

    if (params.speechProviderIds) {
      it("keeps bundled speech ownership explicit", () => {
        expect(findRegistration(params.pluginId).speechProviderIds).toEqual(
          params.speechProviderIds,
        );
        expect(findSpeechProviderIds(params.pluginId)).toEqual(params.speechProviderIds);
      });
    }

    if (params.realtimeTranscriptionProviderIds) {
      it("keeps bundled realtime-transcription ownership explicit", () => {
        expect(findRegistration(params.pluginId).realtimeTranscriptionProviderIds).toEqual(
          params.realtimeTranscriptionProviderIds,
        );
      });
    }

    if (params.realtimeVoiceProviderIds) {
      it("keeps bundled realtime-voice ownership explicit", () => {
        expect(findRegistration(params.pluginId).realtimeVoiceProviderIds).toEqual(
          params.realtimeVoiceProviderIds,
        );
      });
    }

    if (params.mediaUnderstandingProviderIds) {
      it("keeps bundled media-understanding ownership explicit", () => {
        expect(findRegistration(params.pluginId).mediaUnderstandingProviderIds).toEqual(
          params.mediaUnderstandingProviderIds,
        );
        expect(findMediaUnderstandingProviderIds(params.pluginId)).toEqual(
          params.mediaUnderstandingProviderIds,
        );
      });
    }

    if (params.imageGenerationProviderIds) {
      it("keeps bundled image-generation ownership explicit", () => {
        expect(findRegistration(params.pluginId).imageGenerationProviderIds).toEqual(
          params.imageGenerationProviderIds,
        );
        expect(findImageGenerationProviderIds(params.pluginId)).toEqual(
          params.imageGenerationProviderIds,
        );
      });
    }

    if (params.videoGenerationProviderIds) {
      it("keeps bundled video-generation ownership explicit", () => {
        expect(findRegistration(params.pluginId).videoGenerationProviderIds).toEqual(
          params.videoGenerationProviderIds,
        );
        expect(findVideoGenerationProviderIds(params.pluginId)).toEqual(
          params.videoGenerationProviderIds,
        );
      });
    }

    if (params.toolNames) {
      it("keeps bundled tool ownership explicit", () => {
        expect(findRegistration(params.pluginId).toolNames).toEqual(params.toolNames);
      });
    }

    if (params.requireSpeechVoices) {
      it("keeps bundled speech voice-list support explicit", () => {
        expect(findSpeechProvider(params.pluginId).listVoices).toEqual(expect.any(Function));
      });
    }

    if (params.requireDescribeImages) {
      it("keeps bundled multi-image support explicit", () => {
        expect(findMediaUnderstandingProvider(params.pluginId).describeImages).toEqual(
          expect.any(Function),
        );
      });
    }

    if (params.requireGenerateImage) {
      it("keeps bundled image-generation support explicit", () => {
        expect(findImageGenerationProvider(params.pluginId).generateImage).toEqual(
          expect.any(Function),
        );
      });
    }

    if (params.requireGenerateVideo) {
      it("keeps bundled video-generation support explicit", () => {
        expect(findVideoGenerationProvider(params.pluginId).generateVideo).toEqual(
          expect.any(Function),
        );
      });
    }

    const manifestAuthChoice = params.manifestAuthChoice;
    if (manifestAuthChoice) {
      it("keeps onboarding auth grouping explicit", () => {
        const plugin = loadPluginManifestRegistry({}).plugins.find(
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
