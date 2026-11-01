import { mountOpenClawApp } from "./app/app-root.tsx";
import type { prepareApplicationStartup } from "./app/bootstrap-connection.ts";
import { bootstrapApplication } from "./app/bootstrap.ts";
import type { EarlyApplicationGateway } from "./app/early-gateway.ts";
import { reportPendingForegroundActivity } from "./app/foreground-activity.ts";
import { inferControlUiPublicAssetPath } from "./app/public-assets.ts";
import { isRemoteControlUiIngress } from "./app/remote-ingress.ts";
import {
  installMissingStylesheetRecovery,
  installStaleChunkReloadListener,
} from "./app/stale-chunk-reload.ts";
import { CONTROL_UI_BUILD_INFO, controlUiWorkerActivationRetires } from "./build-info.ts";
import { installKeyboardHints } from "./lib/keyboard-hints.ts";
import { listen } from "./lib/reactive/listener.ts";
import kbdStyles from "./components/kbd.css?inline";

export async function startControlUi(
  initial: ReturnType<typeof prepareApplicationStartup>,
  earlyGateway?: EarlyApplicationGateway,
): Promise<void> {
  // HTML paints the critical frame without waiting for CSS. The interactive
  // application still needs its stylesheet, just as it did with a blocking link.
  const bootStyles = document.getElementById("openclaw-boot-styles");
  if (bootStyles instanceof HTMLLinkElement && bootStyles.media === "print") {
    // A stricter embedder CSP can block the inline activation script. Its sheet
    // may already have loaded by the time this module runs.
    if (!bootStyles.sheet && document.readyState !== "complete") {
      await new Promise<void>((resolve) => {
        const ready = () => {
          stopLoad();
          stopError();
          resolve();
        };
        const stopLoad = listen(bootStyles, "load", ready);
        const stopError = listen(bootStyles, "error", ready);
      });
    }
    bootStyles.media = "all";
  }
  installKeyboardHints();
  const root = document.getElementsByTagName("openclaw-app").item(0);
  if (root instanceof HTMLElement) {
    mountOpenClawApp(root, bootstrapApplication(initial, earlyGateway));
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
    // Non-DOM platform listener: document lifetime owns it; no removal is needed.
    listen(navigator.serviceWorker, "message", (event) => {
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
    // Non-DOM platform listener: document lifetime owns it; no removal is needed.
    listen(navigator.serviceWorker, "controllerchange", () => void refresh());
    void navigator.serviceWorker
      .register(swUrl, { updateViaCache: "none" })
      .then((registration) => {
        reportPendingForegroundActivity(registration);
        return refresh();
      })
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
