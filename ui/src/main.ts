import "./ui/browser-compat.ts";
import "./styles.css";
import "./ui/app.ts";

function removeBootShell() {
  const app = document.querySelector("openclaw-app");
  app?.querySelector(".boot-shell")?.remove();
}

removeBootShell();
window.dispatchEvent(new CustomEvent("openclaw-control-ui-ready"));
document.documentElement.setAttribute("data-openclaw-control-ui-ready", "1");

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;
const SERVICE_WORKER_SKIP_WAITING_MESSAGE = "OPENCLAW_CONTROL_SW_SKIP_WAITING";
const SERVICE_WORKER_RELOAD_STORAGE_KEY = "openclaw.control.swReloadedForUpdate";

function activateWaitingServiceWorker(registration: ServiceWorkerRegistration | null | undefined) {
  registration?.waiting?.postMessage(SERVICE_WORKER_SKIP_WAITING_MESSAGE);
}

if (isProd && "serviceWorker" in navigator) {
  const hadServiceWorkerControllerAtStartup = navigator.serviceWorker.controller !== null;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadServiceWorkerControllerAtStartup) {
      return;
    }
    if (sessionStorage.getItem(SERVICE_WORKER_RELOAD_STORAGE_KEY) === "1") {
      return;
    }
    sessionStorage.setItem(SERVICE_WORKER_RELOAD_STORAGE_KEY, "1");
    window.location.reload();
  });
  void navigator.serviceWorker
    .register("./sw.js", { updateViaCache: "none" })
    .then((registration) => {
      if (!registration) {
        return undefined;
      }
      sessionStorage.removeItem(SERVICE_WORKER_RELOAD_STORAGE_KEY);
      activateWaitingServiceWorker(registration);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            // eslint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker.postMessage accepts transfer options, not targetOrigin.
            worker.postMessage(SERVICE_WORKER_SKIP_WAITING_MESSAGE);
          }
        });
      });
      return registration.update().then(
        () => {
          activateWaitingServiceWorker(registration);
        },
        () => undefined,
      );
    });
} else if (!isProd && "serviceWorker" in navigator) {
  // Unregister any leftover dev SW to avoid stale cache issues.
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
}
