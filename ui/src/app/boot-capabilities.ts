import { detectControlUiBrowserCapabilities } from "./browser-capabilities.ts";

export const unsupportedControlUiBrowser = !detectControlUiBrowserCapabilities().supported;

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
