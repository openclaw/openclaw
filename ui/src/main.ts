import { unsupportedControlUiBrowser } from "./app/boot-capabilities.ts";
import "./styles.css";
import { inferControlUiPublicAssetPath } from "./app/public-assets.ts";
import "./app/app-host.ts";
import {
  installMissingStylesheetRecovery,
  installStaleChunkReloadListener,
  scheduleStaleChunkReload,
} from "./app/stale-chunk-reload.ts";
import { CONTROL_UI_BUILD_INFO, controlUiWorkerActivationRetires } from "./build-info.ts";
import { kbdStyles } from "./components/kbd-styles.ts";

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

if (!unsupportedControlUiBrowser) {
  const isProd = (import.meta as ViteImportMeta).env?.PROD === true;
  const currentControlUiBuildId = CONTROL_UI_BUILD_INFO.buildId;

  // Share the exact keyboard-hint rules with shadow roots without making renderers
  // depend on bundler-only CSS imports (they are also imported by Node consumers).
  const keyboardHintStyles = document.createElement("style");
  keyboardHintStyles.textContent = kbdStyles.cssText;
  document.head.append(keyboardHintStyles);

  for (const [selector, asset] of [
    ['link[rel="icon"][type="image/svg+xml"]', "favicon.svg"],
    ['link[rel="icon"][type="image/png"]', "favicon-32.png"],
    ['link[rel="apple-touch-icon"]', "apple-touch-icon.png"],
    ['link[rel="manifest"]', "manifest.webmanifest"],
  ] as const) {
    const link = document.querySelector<HTMLLinkElement>(selector);
    if (link) {
      link.href = inferControlUiPublicAssetPath(asset);
    }
  }
  installStaleChunkReloadListener();
  installMissingStylesheetRecovery();

  if (isProd && "serviceWorker" in navigator) {
    const swUrl = new URL(inferControlUiPublicAssetPath("sw.js"), window.location.origin);
    swUrl.searchParams.set("v", currentControlUiBuildId);
    if (document.documentElement.dataset.openclawProxySessionEntry === "true") {
      swUrl.searchParams.set("session-entry", "1");
    }
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (controlUiWorkerActivationRetires(event.data)) {
        void scheduleStaleChunkReload({
          canReload: () => event.source === navigator.serviceWorker.controller,
        });
      }
      if (event.data?.type === "sw-version-probe") {
        event.ports[0]?.postMessage({ version: currentControlUiBuildId });
      }
    });
    const refresh = () =>
      import("./app/sw-refresh.runtime.ts")
        .then(({ refreshControlUiServiceWorker }) => refreshControlUiServiceWorker())
        .catch((error: unknown) => {
          console.warn("OpenClaw service worker refresh failed.", error);
        });
    navigator.serviceWorker.addEventListener("controllerchange", () => void refresh());
    void navigator.serviceWorker
      .register(swUrl, { updateViaCache: "none" })
      .then(refresh)
      .catch((error: unknown) => {
        console.warn("OpenClaw service worker registration failed.", error);
      });
  } else if (!isProd && "serviceWorker" in navigator) {
    // Unregister any leftover dev SW to avoid stale cache issues.
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const r of registrations) {
        void r.unregister();
      }
    });
  }
}
