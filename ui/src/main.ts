import "./styles.css";
import "./ui/app.ts";

if (import.meta.env?.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("./sw.js");
} else if (!import.meta.env?.PROD && "serviceWorker" in navigator) {
  // Unregister any leftover dev SW to avoid stale cache issues.
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
}
