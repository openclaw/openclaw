import { detectControlUiBrowserCapabilities } from "./browser-capabilities.ts";

type BootImportMeta = ImportMeta & {
  readonly env?: { readonly VITE_OPENCLAW_REQUIRE_MODERN_BROWSER?: string };
};

// Dormant until the Solid cutover release enables this build-time flag.
const REQUIRE_MODERN_BROWSER =
  // SAFETY: Vite owns this optional build-time string; absence leaves the gate disabled.
  (import.meta as BootImportMeta).env?.VITE_OPENCLAW_REQUIRE_MODERN_BROWSER === "true";

export const unsupportedControlUiBrowser =
  REQUIRE_MODERN_BROWSER && !detectControlUiBrowserCapabilities().supported;

if (unsupportedControlUiBrowser) {
  // Both entry and bootstrap depend on this check, including when the bundler
  // moves bootstrap into a shared chunk. Remove the root before registration
  // can start it, and retire document recovery before loading the terminal screen.
  window.dispatchEvent(new Event("openclaw-control-ui-unsupported-browser"));
  document.querySelector("openclaw-app")?.remove();
  void import("./unsupported-browser.ts")
    .then(({ showUnsupportedBrowser }) => {
      showUnsupportedBrowser();
    })
    .catch(() => {
      window.dispatchEvent(new Event("openclaw-control-ui-unsupported-browser-failed"));
    });
}
