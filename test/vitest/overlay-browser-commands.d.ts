export interface OverlayMedia {
  reducedMotion?: "reduce" | "no-preference" | null;
  forcedColors?: "active" | "none" | null;
}

// The browser provider resolves the root Vitest peer; UI tests resolve another peer.
declare module "vitest/internal/browser" {
  interface BrowserCommands {
    overlayEmulateMedia(media: OverlayMedia): Promise<void>;
  }
}
