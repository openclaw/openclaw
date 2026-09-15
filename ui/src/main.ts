// Control UI module implements main behavior.
import "./styles.css";
import "./app/app-host.ts";
import {
  isOwnedControlUiServiceWorkerRegistration,
  shouldRegisterControlUiServiceWorker,
} from "./app/native-web-chrome.ts";
import { inferControlUiPublicAssetPath } from "./app/public-assets.ts";
import {
  installMissingStylesheetRecovery,
  installStaleChunkReloadListener,
  scheduleStaleChunkReload,
} from "./app/stale-chunk-reload.ts";
import { CONTROL_UI_BUILD_INFO, controlUiWorkerActivationRetires } from "./build-info.ts";

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;
const currentControlUiBuildId = CONTROL_UI_BUILD_INFO.buildId;

syncDocumentPublicAssetLinks();
installStaleChunkReloadListener();
installMissingStylesheetRecovery();

if (shouldRegisterControlUiServiceWorker(isProd) && "serviceWorker" in navigator) {
  const swUrl = new URL(inferControlUiPublicAssetPath("sw.js"), window.location.origin);
  swUrl.searchParams.set("v", currentControlUiBuildId);
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
} else if ("serviceWorker" in navigator) {
  // Native WebKit hosts use a persistent data store but do not participate in
  // the browser Control UI service-worker update lifecycle. Retire any worker
  // left by an earlier build so it cannot keep serving an old app shell.
  // Development follows the same cleanup path to avoid stale cache issues.
  const controlUiWorkerUrl = new URL(
    inferControlUiPublicAssetPath("sw.js"),
    window.location.origin,
  );
  const pageUrl = new URL(window.location.href);
  void navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const registration of registrations) {
        if (isOwnedControlUiServiceWorkerRegistration(registration, controlUiWorkerUrl, pageUrl)) {
          void registration
            .unregister()
            .then((unregistered) => {
              if (!unregistered) {
                console.warn("OpenClaw Control UI service worker cleanup was not completed.", {
                  scope: registration.scope,
                });
              }
            })
            .catch((error: unknown) => {
              console.warn("OpenClaw Control UI service worker cleanup failed.", {
                error,
                scope: registration.scope,
              });
            });
        }
      }
    })
    .catch((error: unknown) => {
      console.warn("OpenClaw Control UI service worker cleanup lookup failed.", error);
    });
}

function syncDocumentPublicAssetLinks() {
  setDocumentLinkHref('link[rel="icon"][type="image/svg+xml"]', "favicon.svg");
  setDocumentLinkHref('link[rel="icon"][type="image/png"]', "favicon-32.png");
  setDocumentLinkHref('link[rel="apple-touch-icon"]', "apple-touch-icon.png");
  setDocumentLinkHref('link[rel="manifest"]', "manifest.webmanifest");
}

function setDocumentLinkHref(
  selector: string,
  asset: Parameters<typeof inferControlUiPublicAssetPath>[0],
) {
  const link = document.querySelector<HTMLLinkElement>(selector);
  if (!link) {
    return;
  }
  link.href = inferControlUiPublicAssetPath(asset);
}
