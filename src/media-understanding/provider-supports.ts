import type { MediaUnderstandingCapability, MediaUnderstandingProvider } from "./types.js";

export function providerSupportsCapability(
  provider: MediaUnderstandingProvider | undefined,
  capability: MediaUnderstandingCapability,
): boolean {
  if (!provider) {
    return false;
  }
  if (capability === "audio") {
    return Boolean(provider.transcribeAudio) || Boolean(provider.understandAudio);
  }
  if (capability === "image") {
    return Boolean(provider.describeImage);
  }
  return Boolean(provider.describeVideo) || Boolean(provider.understandVideo);
}
