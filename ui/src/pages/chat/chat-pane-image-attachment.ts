import type { ImageLightboxProps } from "../../components/image-lightbox.types.ts";
import type useLightboxImage from "./chat-pane-image-attachment.runtime.ts";

/** Capture the pane destination before loading the interaction-only attachment operation. */
export function createLightboxComposerAction(
  pane: Parameters<typeof useLightboxImage>[0],
  state: Parameters<typeof useLightboxImage>[1],
): NonNullable<ImageLightboxProps["onUseImage"]> {
  const sessionKey = state.sessionKey;
  const version = state.imageLightboxRequestVersion;
  const connectionGeneration = pane.connectionGeneration;
  return async (item, isSelected) =>
    (await import("./chat-pane-image-attachment.runtime.ts")).default(
      pane,
      state,
      sessionKey,
      version,
      connectionGeneration,
      item,
      isSelected,
    );
}
