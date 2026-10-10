import { commands } from "vitest/browser";

export interface OverlayMedia {
  reducedMotion?: "reduce" | "no-preference" | null;
  forcedColors?: "active" | "none" | null;
}

declare module "vitest/internal/browser" {
  interface BrowserCommands {
    overlayEmulateMedia(media: OverlayMedia): Promise<void>;
  }
}

export function emulateOverlayMedia(media: OverlayMedia) {
  return commands.overlayEmulateMedia(media);
}
