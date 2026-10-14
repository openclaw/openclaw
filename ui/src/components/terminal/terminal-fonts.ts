import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { loadTypefaceStylesheet } from "../../app/typography.ts";
import { forceTerminalRender } from "./terminal-panel-session-types.ts";

let symbols: FontFace | undefined;

/** Fonts never gate PTY startup. Refit the live controller when its faces arrive. */
export function observeTerminalFonts(
  controller: GhosttyTerminalController,
  autoFit: boolean,
): () => void {
  let disposed = false;
  const refresh = () => {
    if (disposed) {
      return;
    }
    controller.terminal.renderer?.remeasureFont();
    if (autoFit) {
      controller.fit();
    }
    forceTerminalRender(controller);
  };
  const stylesheet = loadTypefaceStylesheet("jetbrains-mono");
  stylesheet?.addEventListener("load", refresh);
  document.fonts.addEventListener("loadingdone", refresh);
  if (!symbols) {
    symbols = new FontFace(
      "OpenClaw Nerd Symbols",
      `url("${inferControlUiPublicAssetPath("fonts/symbols-nerd-font-mono.woff2")}")`,
      { display: "swap" },
    );
    document.fonts.add(symbols);
  }
  // FontFaceSet events cover CSS faces; the promise also handles a cached face
  // and a failed download. A late completion cannot touch a disposed renderer.
  void symbols.load().then(refresh, refresh);
  return () => {
    disposed = true;
    stylesheet?.removeEventListener("load", refresh);
    document.fonts.removeEventListener("loadingdone", refresh);
  };
}

export function updateTerminalFont(controller: GhosttyTerminalController, family: string): void {
  const terminal = controller.terminal;
  if (terminal.options.fontFamily === family) {
    return;
  }
  terminal.options.fontFamily = family;
  controller.fit();
  forceTerminalRender(controller);
}
