import type { ImageLightboxProps } from "../../components/image-lightbox.types.ts";
import type useLightboxImage from "./chat-pane-image-attachment.runtime.ts";

/** Capture the pane destination before loading the interaction-only attachment operation. */
export function createLightboxComposerAction(
  pane: Parameters<typeof useLightboxImage>[0],
  state: Parameters<typeof useLightboxImage>[1],
): NonNullable<ImageLightboxProps["onUseImage"]> {
  const target = [
    pane,
    state,
    state.sessionKey,
    state.imageLightboxRequestVersion,
    pane.connectionGeneration,
  ] as const;
  return (...selection) =>
    import("./chat-pane-image-attachment.runtime.ts").then((runtime) =>
      runtime.default(...target, ...selection),
    );
}
