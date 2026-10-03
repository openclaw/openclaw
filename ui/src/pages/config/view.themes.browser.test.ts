import { expect, it, vi } from "vitest";
import { BUILTIN_THEMES } from "../../../../packages/gateway-protocol/src/theme.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import "../../styles.css";
import { renderConfigView } from "./config-view.test-support.ts";

it("offers plugin and personal themes from the shared catalog with their descriptions", () => {
  const setTheme = vi.fn();
  const { container } = renderConfigView({
    activeSection: "__appearance__",
    includeSections: ["__appearance__"],
    setTheme,
    themeCatalog: {
      error: null,
      themes: [
        ...BUILTIN_THEMES,
        {
          id: "space-pack/xenovessel",
          name: "Xenovessel",
          description: "Alien indigo surfaces, lime controls, and monospace typography.",
          source: "plugin",
          pluginId: "space-pack",
          modes: ["dark"],
        },
        {
          id: "user/candlelight",
          name: "Candlelight",
          description: "Warm cream surfaces with amber accents and serif text.",
          source: "user",
          modes: ["light"],
        },
      ],
    },
  });
  const pluginTheme = container.querySelector<HTMLButtonElement>(
    '[data-theme-id="space-pack/xenovessel"]',
  );
  expect(pluginTheme?.title).toBe(
    "Alien indigo surfaces, lime controls, and monospace typography.",
  );
  pluginTheme?.click();
  expect(setTheme).toHaveBeenCalledWith("space-pack/xenovessel");
  expect(container.querySelector('[data-theme-id="user/candlelight"]')?.textContent).toContain(
    "Candlelight",
  );
});

it.each(["profile", "device-local"] as const)(
  "shows Claw presentation while preserving an unavailable %s plugin selection",
  async (provenance) => {
    const missingTheme = "space-pack/xenovessel";
    const { container, props } = renderConfigView({
      activeSection: "__appearance__",
      includeSections: ["__appearance__"],
      theme: missingTheme,
      themeOverridden: true,
      themeProvenance: provenance,
      themeCatalog: {
        error: null,
        themes: [...BUILTIN_THEMES],
        ...(provenance === "profile" ? { unavailableId: missingTheme } : {}),
      },
    });
    await updatePickers(container);
    expect(container.textContent).toContain(
      `${missingTheme} is unavailable. Using Claw until the theme becomes available again.`,
    );
    const claw = container.querySelector<HTMLButtonElement>('[data-theme-id="claw"]');
    expect(claw?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-accent-preset="default"]')?.classList).toContain(
      "settings-accent-theme--claw",
    );
    for (const slot of ["ui", "chat"]) {
      const picker = container
        .querySelector(`#settings-font-${slot}`)
        ?.closest("openclaw-select-picker");
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
  const { container } = renderConfigView({
    activeSection: "__appearance__",
    includeSections: ["__appearance__"],
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
