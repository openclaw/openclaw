import { inferControlUiPublicAssetPath } from "./public-assets.ts";

type ControlUiDocumentHead = {
  readonly themeColors: readonly HTMLMetaElement[];
  readonly favicons: readonly HTMLLinkElement[];
};

let elements: ControlUiDocumentHead = { themeColors: [], favicons: [] };

/** The document entrypoint binds its static head nodes before mounting the app. */
function bindControlUiDocumentHead(head: ControlUiDocumentHead): void {
  elements = head;
}

/** Set document assets before the entry module yields to the application import. */
export function initializeControlUiDocumentHead(): void {
  const themeColors: HTMLMetaElement[] = [];
  for (const id of ["openclaw-theme-color-light", "openclaw-theme-color-dark"]) {
    const meta = document.getElementById(id);
    if (meta instanceof HTMLMetaElement) {
      themeColors.push(meta);
    }
  }
  const favicons: HTMLLinkElement[] = [];
  for (const [id, asset] of [
    ["openclaw-favicon-svg", "favicon.svg"],
    ["openclaw-favicon-png", "favicon-32.png"],
    ["openclaw-apple-touch-icon", "apple-touch-icon.png"],
    ["openclaw-manifest", "manifest.webmanifest"],
  ] as const) {
    const link = document.getElementById(id);
    if (link instanceof HTMLLinkElement) {
      link.href = inferControlUiPublicAssetPath(asset);
      if (link.rel === "icon") {
        favicons.push(link);
      }
    }
  }
  bindControlUiDocumentHead({ themeColors, favicons });
}

export function controlUiDocumentHead(): ControlUiDocumentHead {
  return elements;
}
