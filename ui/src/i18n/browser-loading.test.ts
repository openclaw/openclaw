import { describe, expect, it } from "vitest";
import { useLazyEnglishTest } from "./lazy-english.test-support.ts";

const loadI18n = useLazyEnglishTest();

describe("Browser English loading", () => {
  it.each([
    { surface: "annotation", load: () => import("../components/browser/browser-annotation.ts") },
    {
      surface: "controller",
      load: () => import("../components/browser/browser-panel-controller.ts"),
    },
    { surface: "client", load: () => import("../components/browser/browser-client.ts") },
    { surface: "toolbar", load: () => import("../components/browser/browser-panel-render.ts") },
  ])(
    "loads fallback copy from the standalone $surface without replacing siblings",
    async ({ load }) => {
      const { en, manager } = await loadI18n();
      const browser = en.browser;
      const errors = browser.errors;
      const annotatePrompt = browser.annotatePrompt;
      const sibling = browser.loading;
      expect(browser.downloading).toBeUndefined();
      expect(browser.downloadFile).toBeUndefined();
      expect(browser.navigationBlocked).toBeUndefined();
      expect(errors.downloadFailed).toBeUndefined();
      expect(errors.downloadEmpty).toBeUndefined();
      expect(annotatePrompt.introUntitled).toBeUndefined();

      await manager.setLocale("de");
      await load();

      expect(en.browser).toBe(browser);
      expect(en.browser.errors).toBe(errors);
      expect(en.browser.annotatePrompt).toBe(annotatePrompt);
      expect(browser.loading).toBe(sibling);
      expect(errors.screenshotPathMissing).toBe("Browser screenshot did not return a media path.");
      expect(manager.t("common.health")).toBe("Gesundheit");
      expect(manager.t("browser.downloading")).toBe("Downloading…");
      expect(manager.t("browser.downloadFile")).toBe("Download file");
      expect(manager.t("browser.navigationBlocked")).toBe(
        "The current browser navigation rules block this address. Select another tab or enter an allowed address.",
      );
      expect(manager.t("browser.errors.downloadEmpty")).toBe("No file returned.");
      expect(
        manager.t("browser.annotatePrompt.introUntitled", { url: "https://example.com" }),
      ).toBe(
        "I annotated the page at https://example.com — the attached screenshot shows my markup.",
      );
      expect(manager.t("browser.errors.downloadFailed", { error: "HTTP 403" })).toBe(
        "Could not download this file: HTTP 403. Try again, or open it in your browser to save it.",
      );
    },
  );
});
