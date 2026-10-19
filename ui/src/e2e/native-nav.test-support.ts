import type { Page } from "playwright";

export async function installNativeEmbed(
  page: Page,
  host: { platform: "ios" | "macos" | "android"; formFactor: "phone" | "pad" | "desktop" },
): Promise<void> {
  await page.addInitScript((embed) => {
    Object.assign(window, { __OPENCLAW_NATIVE_EMBED__: embed });
  }, host);
}

// Mirror the native app's document-start flags and document-end chrome styling.
export async function installNativeWebChrome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeWindow = window as Window & {
      __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
      __OPENCLAW_NATIVE_HISTORY__?: { canGoBack: boolean; canGoForward: boolean };
    };
    nativeWindow["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
    nativeWindow["__OPENCLAW_NATIVE_HISTORY__"] = {
      canGoBack: false,
      canGoForward: false,
    };
    const stamp = () => {
      document.documentElement.classList.add("openclaw-native-macos", "openclaw-native-web-chrome");
      document.documentElement.style.setProperty("--openclaw-native-titlebar-height", "52px");
      // The app also pads both desktop navigation surfaces past AppKit's
      // window controls (DashboardWindowController.installNativeChromeScript).
      const style = document.createElement("style");
      style.id = "openclaw-native-macos-chrome";
      style.textContent = `@media (min-width: 700px) {
        html.openclaw-native-macos .sidebar-shell,
        html.openclaw-native-macos .settings-sidebar__header {
          padding-top: max(14px, var(--openclaw-native-titlebar-height)) !important;
        }
      }`;
      (document.head ?? document.documentElement).appendChild(style);
    };
    if (document.documentElement) {
      stamp();
    } else {
      document.addEventListener("DOMContentLoaded", stamp);
    }
  });
}
