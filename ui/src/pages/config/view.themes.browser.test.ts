import { expect, it, onTestFinished, vi } from "vitest";
import {
  BUILTIN_THEMES,
  type ThemeCatalogEntry,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { installTitleTooltips } from "../../components/tooltip-title.ts";
import { updatePickers, openPicker } from "../../test-helpers/select-picker.ts";
import "../../styles.css";
import { renderAppearance } from "./config-view.test-support.tsx";

const catalog = (...themes: ThemeCatalogEntry[]) => ({ error: null, themes });
const theme = (
  id: ThemeCatalogEntry["id"],
  name: string,
  overrides: Partial<ThemeCatalogEntry> = {},
): ThemeCatalogEntry => ({
  id,
  name,
  description: "Test theme",
  source: "user",
  modes: ["dark"],
  ...overrides,
});
const themeButton = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLButtonElement>(`[data-theme-id="${id}"]`);

it("hides the collection and visit controls without changing their saved preferences", () => {
  const { container, props } = renderAppearance({
    theme: "user/quiet",
    themeCatalog: catalog(theme("user/quiet", "Quiet", { lobsterdex: false })),
    lobsterPetVisits: true,
    lobsterPetSounds: true,
    lobsterdexHref: "/settings/lobsterdex",
  });
  expect(container.querySelector(".lobsterdex__gallery, .lobsterdex__open")).toBeNull();
  expect(container.textContent).not.toContain("Lobster visits");
  expect(container.textContent).not.toContain("Lobster sounds");
  expect(props).toMatchObject({ lobsterPetVisits: true, lobsterPetSounds: true });
  expect(props.onAppearanceChange).not.toHaveBeenCalled();
});

it("offers plugin and personal themes with names in focus and hover hints", async () => {
  const setTheme = vi.fn();
  const importedName = "Imported Manuscript Theme With A Long Name";
  const importedDescription = "A palette for long-form writing";
  const { container } = renderAppearance({
    setTheme,
    themeCatalog: catalog(
      ...BUILTIN_THEMES,
      theme("space-pack/xenovessel", "Xenovessel", {
        description: "Alien theme",
        source: "plugin",
        pluginId: "space-pack",
      }),
      theme("user/candlelight", "Candlelight", {
        modes: ["light"],
      }),
      theme("user/long-name", importedName, { description: importedDescription }),
    ),
  });
  document.body.append(container);
  const disposeTooltips = installTitleTooltips(document);
  onTestFinished(() => {
    disposeTooltips();
    container.remove();
  });

  const pluginTheme = themeButton(container, "space-pack/xenovessel");
  pluginTheme?.click();
  expect(setTheme).toHaveBeenCalledWith("space-pack/xenovessel");
  expect(themeButton(container, "user/candlelight")?.textContent).toContain("Candlelight");

  const manuscript = themeButton(container, "manuscript");
  if (!manuscript) {
    throw new Error("Expected the Manuscript theme card");
  }
  expect(manuscript.getAttribute("aria-pressed")).toBe("false");
  manuscript.focus();

  const { page } = await import("vitest/browser");
  const focusTooltip = page.getByRole("tooltip").last();
  await expect.element(focusTooltip).toBeVisible();
  expect(focusTooltip.element().textContent).toContain("Manuscript — Ink on paper");
  expect(manuscript.getAttribute("aria-pressed")).toBe("false");

  const importedTheme = themeButton(container, "user/long-name");
  if (!importedTheme) {
    throw new Error("Expected the imported theme card");
  }
  const importedLabel = importedTheme.querySelector<HTMLElement>(".settings-theme-card__label");
  if (!importedLabel) {
    throw new Error("Expected the imported theme label");
  }
  expect(importedLabel.textContent).toBe(importedName);
  expect(importedTheme.getAttribute("aria-pressed")).toBe("false");

  manuscript.blur();
  await page.elementLocator(importedTheme).hover();
  const hoverTooltip = page.getByRole("tooltip").last();
  await expect.element(hoverTooltip).toBeVisible();
  expect(hoverTooltip.element().textContent).toContain(`${importedName} — ${importedDescription}`);
  expect(importedTheme.getAttribute("aria-pressed")).toBe("false");
});

it.each(["profile", "device-local"] as const)(
  "shows Claw presentation while preserving an unavailable %s plugin selection",
  async (provenance) => {
    const missingTheme = "space-pack/xenovessel";
    const { container, props } = renderAppearance({
      theme: missingTheme,
      themeOverridden: true,
      themeProvenance: provenance,
      themeCatalog: {
        ...catalog(...BUILTIN_THEMES),
        ...(provenance === "profile" ? { unavailableId: missingTheme } : {}),
      },
    });
    await updatePickers(container);
    expect(container.textContent).toContain(
      `${missingTheme} is unavailable. Using Claw until the theme becomes available again.`,
    );
    const claw = themeButton(container, "claw");
    expect(claw?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-accent-preset="default"]')?.classList).toContain(
      "settings-accent-theme--claw",
    );
    for (const slot of ["ui", "chat"]) {
      const picker = await openPicker(container.querySelector(`#settings-font-${slot}`)!);
      expect(picker?.querySelector('[role="option"][data-value="theme"]')?.textContent).toContain(
        "Claw · Instrument Sans",
      );
    }
    expect(props.theme).toBe(missingTheme);
    claw?.click();
    expect(props.setTheme).toHaveBeenCalledWith("claw");
  },
);

it("offers an explicit retry when the theme catalog cannot load", () => {
  const onRetryThemeCatalog = vi.fn();
  const { container } = renderAppearance({
    themeCatalog: { themes: [...BUILTIN_THEMES], error: "Theme palette temporarily unavailable" },
    onRetryThemeCatalog,
  });
  const error = container.querySelector('[role="alert"]');
  expect(error?.textContent).toContain("Theme palette temporarily unavailable");
  const retry = error?.querySelector<HTMLButtonElement>("button");
  expect(retry?.textContent?.trim()).toBe("Retry");
  retry?.click();
  expect(onRetryThemeCatalog).toHaveBeenCalledOnce();
});
