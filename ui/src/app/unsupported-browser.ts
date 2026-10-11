import "./unsupported-browser.css";
import { i18n, t } from "../i18n/lib/translate.ts";
import { registerLoginEnglish } from "../i18n/locales/en-login.ts";
import { postNativeExternalLink } from "./native-link-routing.ts";
import { webKitHostWindow } from "./native-webkit-bridge.ts";
import fallbackDocument from "./unsupported-browser.html?raw";

export function showUnsupportedBrowser(): void {
  registerLoginEnglish();
  const parsed = new DOMParser().parseFromString(fallbackDocument, "text/html");
  const surface = parsed.querySelector<HTMLElement>("main")!;
  let actionResult: "opened" | "failed" | undefined;
  const status = surface.querySelector<HTMLElement>('[role="status"]')!;
  const translate = () => {
    const copy: Record<string, string> = {
      title: t("login.unsupportedBrowser.title"),
      description: t("login.unsupportedBrowser.description"),
      apple: t("login.unsupportedBrowser.apple"),
      browsers: t("login.unsupportedBrowser.browsers"),
      native: t("login.unsupportedBrowser.native"),
      open: t("login.unsupportedBrowser.open"),
      opened: t("login.unsupportedBrowser.opened"),
      failed: t("login.unsupportedBrowser.failed"),
    };
    for (const element of surface.querySelectorAll<HTMLElement>("[data-copy]")) {
      element.textContent = copy[element.dataset.copy ?? ""] ?? "";
    }
    status.textContent = actionResult ? (copy[actionResult] ?? "") : "";
  };
  translate();
  i18n.subscribe(translate);
  if (webKitHostWindow()?.webkit?.messageHandlers?.openclawLink) {
    surface.querySelector<HTMLElement>("[data-native-action]")!.hidden = false;
    surface.querySelector("button")!.addEventListener("click", () => {
      actionResult = postNativeExternalLink(window.location.href) ? "opened" : "failed";
      translate();
    });
  }
  document.body.replaceChildren(surface);
  // This terminal screen is rendered; the static mount watchdog must not reload it.
  window.dispatchEvent(new Event("openclaw-control-ui-rendered"));
  surface.focus();
}
