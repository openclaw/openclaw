import { parsePwaIconRoute } from "../../../src/gateway/pwa-icon-contract.js";
import { getSafeLocalStorage } from "../local-storage.ts";
import { resolveControlUiPaths } from "./browser.ts";
import { inferControlUiPublicAssetPath } from "./public-assets.ts";

type ControlUiDocumentHead = {
  readonly themeColors: readonly HTMLMetaElement[];
  readonly favicons: readonly HTMLLinkElement[];
};

let elements: ControlUiDocumentHead = { themeColors: [], favicons: [] };

function installIconStorageKey(): string {
  return "openclaw.installIcon.v1:" + resolveControlUiPaths(window.location.pathname)[1];
}

function isInstallIconPath(path: string): boolean {
  const route = parsePwaIconRoute(path, resolveControlUiPaths(window.location.pathname)[1]);
  return route?.kind === "asset" && path.endsWith("/icon.png");
}

/** This browser's install artwork, independent of tab status or selected session. */
export function currentPwaInstallIcon(): string | null {
  try {
    const path = getSafeLocalStorage()?.getItem(installIconStorageKey());
    return path && isInstallIconPath(path) ? path : null;
  } catch {
    return null;
  }
}

export function selectPwaInstallIcon(iconUrl: string | null): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    throw new Error("Browser storage is unavailable");
  }
  if (iconUrl === null) {
    storage.removeItem(installIconStorageKey());
  } else if (isInstallIconPath(iconUrl)) {
    storage.setItem(installIconStorageKey(), iconUrl);
  } else {
    throw new Error("Invalid install icon receipt");
  }
  applyInstallLinks();
}

function applyInstallLinks(): void {
  const icon = currentPwaInstallIcon();
  for (const [id, asset, custom] of [
    [
      "openclaw-apple-touch-icon",
      "apple-touch-icon.png",
      icon?.replace(/icon\.png$/u, "apple-touch-icon.png"),
    ],
    [
      "openclaw-manifest",
      "manifest.webmanifest",
      icon?.replace(/icon\.png$/u, "manifest.webmanifest"),
    ],
  ] as const) {
    const link = document.getElementById(id);
    if (link instanceof HTMLLinkElement) {
      link.href = custom ?? inferControlUiPublicAssetPath(asset);
    }
  }
}

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
  ] as const) {
    const link = document.getElementById(id);
    if (link instanceof HTMLLinkElement) {
      link.href = inferControlUiPublicAssetPath(asset);
      if (link.rel === "icon") {
        favicons.push(link);
      }
    }
  }
  applyInstallLinks();
  bindControlUiDocumentHead({ themeColors, favicons });
}

export function controlUiDocumentHead(): ControlUiDocumentHead {
  return elements;
}
