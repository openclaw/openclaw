import { detectControlUiBrowserCapabilities } from "./browser-capabilities.ts";

export const unsupportedControlUiBrowser = !detectControlUiBrowserCapabilities().supported;

if (unsupportedControlUiBrowser) {
  // Retire document recovery even while the terminal screen's assets are loading.
  // The entry point mounts the plain app root only after capability admission.
  window.dispatchEvent(new Event("openclaw-control-ui-unsupported-browser"));
  void import("./unsupported-browser.ts")
    .then(({ showUnsupportedBrowser }) => {
      showUnsupportedBrowser();
    })
    .catch(() => {
      window.dispatchEvent(new Event("openclaw-control-ui-unsupported-browser-failed"));
    });
}
