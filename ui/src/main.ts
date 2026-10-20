import { mountOpenClawApp } from "./app/app-root.tsx";
import "./styles.css";
import { unsupportedControlUiBrowser } from "./app/boot-capabilities.ts";
import { bindControlUiDocumentHead } from "./app/control-ui-document-head.ts";
import { inferControlUiPublicAssetPath } from "./app/public-assets.ts";
import { isRemoteControlUiIngress } from "./app/remote-ingress.ts";
import {
  installMissingStylesheetRecovery,
  installStaleChunkReloadListener,
} from "./app/stale-chunk-reload.ts";
import { CONTROL_UI_BUILD_INFO, controlUiWorkerActivationRetires } from "./build-info.ts";
import kbdStyles from "./components/kbd.css?inline";

if (!unsupportedControlUiBrowser) {
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

  const root = document.getElementsByTagName("openclaw-app").item(0);
  if (root instanceof HTMLElement) {
    mountOpenClawApp(root);
  }
  const isProd = import.meta.env.PROD;
  const currentControlUiBuildId = CONTROL_UI_BUILD_INFO.buildId;

  // Share the exact keyboard-hint rules with shadow roots without making renderers
  // depend on bundler-only CSS imports (they are also imported by Node consumers).
  const keyboardHintStyles = document.createElement("style");
  keyboardHintStyles.textContent = kbdStyles;
  document.head.append(keyboardHintStyles);

  installStaleChunkReloadListener();
  installMissingStylesheetRecovery();

  if (isRemoteControlUiIngress() && window.parent !== window) {
    void import("./app/native-gateways.runtime.ts")
      .then(({ nativeGatewaysCapability }) => nativeGatewaysCapability())
      .catch((error: unknown) => {
        console.warn("OpenClaw embedder Gateway switcher failed to load.", error);
      });
  }

  if (isProd && !isRemoteControlUiIngress() && "serviceWorker" in navigator) {
    const swUrl = new URL(inferControlUiPublicAssetPath("sw.js"), window.location.origin);
    swUrl.searchParams.set("v", currentControlUiBuildId);
    if (document.documentElement.dataset.openclawProxySessionEntry === "true") {
      swUrl.searchParams.set("session-entry", "1");
    }
    const refresh = () =>
      import("./app/sw-refresh.runtime.ts")
        .then(({ refreshControlUiServiceWorker }) => refreshControlUiServiceWorker())
        .catch((error: unknown) => {
          console.warn("OpenClaw service worker refresh failed.", error);
        });
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (
        event.source === navigator.serviceWorker.controller &&
        controlUiWorkerActivationRetires(event.data)
      ) {
        // A fresh document can still be controlled by the preceding build.
        void refresh();
      }
      if (event.data?.type === "sw-version-probe") {
        event.ports[0]?.postMessage({ version: currentControlUiBuildId });
      }
    });
    navigator.serviceWorker.addEventListener("controllerchange", () => void refresh());
    void navigator.serviceWorker
      .register(swUrl, { updateViaCache: "none" })
      .then(refresh)
      .catch((error: unknown) => {
        console.warn("OpenClaw service worker registration failed.", error);
      });
  } else if (!isProd && !isRemoteControlUiIngress() && "serviceWorker" in navigator) {
    // Unregister any leftover dev SW to avoid stale cache issues.
    void navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const r of registrations) {
        void r.unregister();
      }
    });
  }
}
