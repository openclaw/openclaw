import { expect, it, onTestFinished, vi } from "vitest";
import {
  BUILTIN_THEMES,
  type ThemeCatalogEntry,
} from "../../../../packages/gateway-protocol/src/theme.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import "../../styles.css";
import { renderAppearance, renderConfigInto } from "./config-view.test-support.tsx";

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
function renderConnectedAppearance(overrides: Parameters<typeof renderAppearance>[0]) {
  const view = renderAppearance(overrides);
  document.body.append(view.container);
  onTestFinished(() => {
    cleanupSolid();
    view.container.remove();
  });
  return view;
}

function themeRadio(container: HTMLElement, id: string) {
  const input = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (radio) => radio.value === id,
  );
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input!;
}

function previewAndApply(view: ReturnType<typeof renderAppearance>, id: ThemeCatalogEntry["id"]) {
  themeRadio(view.container, id).click();
  flush();
  expect(themeRadio(view.container, id).checked).toBe(true);
  expect(view.props.setTheme).not.toHaveBeenCalled();
  const click = (name: string) => {
    const button = [...view.container.querySelectorAll("button")].find(
      (entry) => entry.textContent?.trim() === name,
    );
    expect(button).toBeInstanceOf(HTMLButtonElement);
    button?.click();
    flush();
  };
  click("Preview theme");
  expect(view.props.setThemePreview).toHaveBeenCalledWith(id);
  expect(view.props.setTheme).not.toHaveBeenCalled();
  view.props.themePreview = id;
  renderConfigInto(view.props, view.container);
  click("Apply theme");
  expect(view.props.setTheme).toHaveBeenCalledExactlyOnceWith(id);
}

it("hides the collection and visit controls without changing their saved preferences", () => {
  const { container, props } = renderConnectedAppearance({
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

it("offers plugin and personal themes from the shared catalog with their descriptions", () => {
  const setTheme = vi.fn();
  const view = renderConnectedAppearance({
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
    ),
  });
  const { container } = view;
  const pluginTheme = themeRadio(container, "space-pack/xenovessel");
  expect(pluginTheme.parentElement?.textContent).toContain("Alien theme");
  previewAndApply(view, "space-pack/xenovessel");
  expect(themeRadio(container, "user/candlelight").getAttribute("aria-label")).toBe("Candlelight");
});

it.each(["profile", "device-local"] as const)(
  "shows Claw presentation while preserving an unavailable %s plugin selection",
  async (provenance) => {
    const missingTheme = "space-pack/xenovessel";
    const view = renderConnectedAppearance({
      theme: missingTheme,
      themeOverridden: true,
      themeProvenance: provenance,
      themeCatalog: {
        ...catalog(...BUILTIN_THEMES),
        ...(provenance === "profile" ? { unavailableId: missingTheme } : {}),
      },
    });
    const { container, props } = view;
    await updatePickers(container);
    expect(container.textContent).toContain(
      `${missingTheme} is unavailable. Using Claw until the theme becomes available again.`,
    );
    const claw = themeRadio(container, "claw");
    expect(claw.checked).toBe(true);
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
    previewAndApply(view, "claw");
  },
);

it("offers an explicit retry when the theme catalog cannot load", () => {
  const onRetryThemeCatalog = vi.fn();
  const { container } = renderConnectedAppearance({
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
