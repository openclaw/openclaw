/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n, t } from "../i18n/index.ts";
import { createState } from "./app-render.assistant-avatar.test.ts";
import { renderApp } from "./app-render.ts";

const localStorageValues = new Map<string, string>();

vi.mock("../local-storage.ts", () => ({
  getSafeLocalStorage: () => ({
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    removeItem: (key: string) => localStorageValues.delete(key),
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
  }),
  getSafeSessionStorage: () => null,
}));

vi.mock("./icons.ts", () => ({
  icons: {},
}));

beforeEach(async () => {
  localStorageValues.clear();
  await i18n.setLocale("en");
});

describe("renderApp Skill Workshop mode switcher (rendered proof)", () => {
  it("renders the mode switcher with resolved English labels", () => {
    const container = document.createElement("div");
    render(
      renderApp(
        createState({
          tab: "skillWorkshop",
          skillWorkshopMode: "board",
          skillWorkshopQuery: "",
          skillWorkshopProposals: [],
        }),
      ),
      container,
    );

    const tablist = container.querySelector<HTMLElement>(".sw-mode-switch");
    expect(tablist, "expected .sw-mode-switch to render").not.toBeNull();
    expect(tablist?.getAttribute("role")).toBe("tablist");
    expect(tablist?.getAttribute("aria-label")).toBe(t("skillWorkshop.modeSwitcher.label"));
    expect(tablist?.getAttribute("aria-label")).toBe("Workshop view");

    const buttons = tablist?.querySelectorAll<HTMLButtonElement>(".sw-mode-switch__opt");
    expect(buttons?.length).toBe(2);
    expect(buttons?.[0]?.getAttribute("title")).toBe("Board view");
    expect(buttons?.[0]?.textContent?.trim()).toBe("Board");
    expect(buttons?.[0]?.getAttribute("aria-selected")).toBe("true");
    expect(buttons?.[1]?.getAttribute("title")).toBe("Today view");
    expect(buttons?.[1]?.textContent?.trim()).toBe("Today");
    expect(buttons?.[1]?.getAttribute("aria-selected")).toBe("false");
  });

  it("falls back to English for the new keys when locale has no translation", async () => {
    // The five new keys are still in fallbackKeys for every non-English locale
    // until translators run, so the rendered switcher should be identical to
    // the English render in any non-English locale.
    const locales = ["de", "es", "ja-JP", "zh-CN", "ar", "fr"] as const;
    for (const locale of locales) {
      await i18n.setLocale(locale);
      const container = document.createElement("div");
      render(
        renderApp(
          createState({
            tab: "skillWorkshop",
            skillWorkshopMode: "board",
            skillWorkshopQuery: "",
            skillWorkshopProposals: [],
          }),
        ),
        container,
      );

      const tablist = container.querySelector<HTMLElement>(".sw-mode-switch");
      expect(tablist, `${locale}: .sw-mode-switch`).not.toBeNull();
      expect(tablist?.getAttribute("aria-label"), `${locale}: aria-label`).toBe("Workshop view");
      const buttons = tablist?.querySelectorAll<HTMLButtonElement>(".sw-mode-switch__opt");
      expect(buttons?.[0]?.getAttribute("title"), `${locale}: board title`).toBe("Board view");
      expect(buttons?.[0]?.textContent?.trim(), `${locale}: board text`).toBe("Board");
      expect(buttons?.[1]?.getAttribute("title"), `${locale}: today title`).toBe("Today view");
      expect(buttons?.[1]?.textContent?.trim(), `${locale}: today text`).toBe("Today");
    }
  });

  it("emits the rendered switcher HTML for the PR proof (de locale)", async () => {
    // This is the "copied live output" the PR needs. We render the actual
    // Control UI render path with a non-English locale and dump the resulting
    // switcher HTML so the contributor can paste it into the PR body.
    await i18n.setLocale("de");
    const container = document.createElement("div");
    render(
      renderApp(
        createState({
          tab: "skillWorkshop",
          skillWorkshopMode: "board",
          skillWorkshopQuery: "",
          skillWorkshopProposals: [],
        }),
      ),
      container,
    );

    const tablist = container.querySelector<HTMLElement>(".sw-mode-switch");
    expect(tablist).not.toBeNull();
    const rendered = tablist?.outerHTML ?? "";
    process.stdout.write("\n--- rendered .sw-mode-switch (de) ---\n");
    process.stdout.write(rendered);
    process.stdout.write("\n--- end rendered ---\n");
    expect(rendered).toContain('aria-label="Workshop view"');
    expect(rendered).toContain('title="Board view"');
    expect(rendered).toContain('title="Today view"');
    expect(rendered).toMatch(/>Board<\/span>/);
    expect(rendered).toMatch(/>Today<\/span>/);
  });
});
