import "./unsupported-browser.css";
import { i18n, t } from "../i18n/lib/translate.ts";
import { registerLoginEnglish } from "../i18n/locales/en-login.ts";
import { listen } from "../lib/reactive/listener.ts";
import { postNativeExternalLink } from "./native-link-routing.ts";
import { webKitHostWindow } from "./native-webkit-bridge.ts";

export function showUnsupportedBrowser(): void {
  registerLoginEnglish();
  // Native DOM keeps browser guidance independent of the runtime it rejected.
  const surface = document.createElement("main");
  surface.className = "unsupported-browser";
  surface.setAttribute("aria-labelledby", "unsupported-browser-title");
  surface.tabIndex = -1;
  const panel = document.createElement("div");
  panel.className = "unsupported-browser__panel";
  const brand = document.createElement("p");
  brand.className = "unsupported-browser__brand";
  brand.textContent = "OpenClaw";
  const copyElements = {
    title: document.createElement("h1"),
    description: document.createElement("p"),
    apple: document.createElement("li"),
    browsers: document.createElement("li"),
    native: document.createElement("p"),
    open: document.createElement("button"),
  };
  copyElements.title.id = "unsupported-browser-title";
  copyElements.open.type = "button";
  copyElements.open.setAttribute("data-new-tab-action", "");
  const copyEntries = Object.entries(copyElements);
  for (const [key, element] of copyEntries) {
    element.dataset.copy = key;
  }
  const requirements = document.createElement("ul");
  requirements.append(copyElements.apple, copyElements.browsers);
  const nativeAction = document.createElement("div");
  nativeAction.setAttribute("data-native-action", "");
  nativeAction.hidden = true;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  nativeAction.append(copyElements.native, copyElements.open, status);
  panel.append(brand, copyElements.title, copyElements.description, requirements, nativeAction);
  surface.append(panel);
  let actionResult: "opened" | "failed" | undefined;
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
    for (const [key, element] of copyEntries) {
      element.textContent = copy[key] ?? "";
    }
    status.textContent = actionResult ? (copy[actionResult] ?? "") : "";
  };
  translate();
  i18n.subscribe(translate);
  if (webKitHostWindow()?.webkit?.messageHandlers?.openclawLink) {
    nativeAction.hidden = false;
    listen(copyElements.open, "click", () => {
      actionResult = postNativeExternalLink(window.location.href) ? "opened" : "failed";
      translate();
    });
  }
  document.body.replaceChildren(surface);
  // This terminal screen is rendered; the static mount watchdog must not reload it.
  window.dispatchEvent(new Event("openclaw-control-ui-rendered"));
  surface.focus();
}
