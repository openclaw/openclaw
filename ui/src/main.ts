import "./styles.css";
import "./ui/app.ts";
import { autoMountKioskOnHashRoute } from "./ui/kiosk/kiosk-bootstrap.ts";

// Self-bootstrap: if the URL is #/kiosk, wait for the gateway client to
// come online and mount the wall-tablet kiosk view. No-op otherwise.
autoMountKioskOnHashRoute();

type ViteImportMeta = ImportMeta & {
  readonly env?: {
    readonly PROD?: boolean;
  };
};

const isProd = (import.meta as ViteImportMeta).env?.PROD === true;

if (isProd && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("./sw.js");
} else if (!isProd && "serviceWorker" in navigator) {
  // Unregister any leftover dev SW to avoid stale cache issues.
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
}
