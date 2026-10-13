import { commands } from "vitest/browser";
import type { OverlayMedia } from "../../../test/vitest/overlay-browser-commands.js";

export type { OverlayMedia } from "../../../test/vitest/overlay-browser-commands.js";

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    overlayEmulateMedia(media: OverlayMedia): Promise<void>;
  }
}

export function emulateOverlayMedia(media: OverlayMedia) {
  return commands.overlayEmulateMedia(media);
}
