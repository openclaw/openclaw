import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { renderTopbarLocaleSelect } from "./app-render.helpers.ts";
import type { AppViewState } from "./app-view-state.ts";

function createLocaleState(applySettings = vi.fn()) {
  return {
    settings: {
      gatewayUrl: "",
      token: "",
      locale: "en",
      sessionKey: "main",
      lastActiveSessionKey: "main",
      theme: "claw",
      themeMode: "dark",
      splitRatio: 0.6,
      navWidth: 280,
      navCollapsed: false,
      navGroupsCollapsed: {},
      borderRadius: 50,
      chatFocusMode: false,
      chatShowThinking: false,
      chatShowToolCalls: true,
    },
    applySettings,
  } as unknown as AppViewState;
}

describe("topbar locale picker", () => {
  it("renders the dashboard locale picker and stores language changes", async () => {
    await i18n.setLocale("en");
    try {
      const container = document.createElement("div");
      const applySettings = vi.fn();

      render(renderTopbarLocaleSelect(createLocaleState(applySettings)), container);
      await Promise.resolve();

      const select = container.querySelector<HTMLSelectElement>(".topbar-locale__select");
      expect(select).not.toBeNull();
      expect(select?.getAttribute("aria-label")).toBe("Language");
      expect(select?.querySelector('option[value="vi"]')?.textContent?.trim()).toContain(
        "Tiếng Việt",
      );

      select!.value = "vi";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();

      expect(applySettings).toHaveBeenCalledWith(expect.objectContaining({ locale: "vi" }));
      expect(i18n.getLocale()).toBe("vi");
    } finally {
      await i18n.setLocale("en");
    }
  });
});
