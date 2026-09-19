import { nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { i18n, t } from "../../i18n/index.ts";
import "../../styles.css";
import { createProps } from "./view.test-support.ts";
import { renderSkills } from "./view.ts";

const container = document.createElement("openclaw-skills-page");

afterEach(async () => {
  render(nothing, container);
  container.remove();
  await i18n.setLocale("en");
});

describe("Skills refresh layout", () => {
  it.each([
    { width: 1440, locale: "en" },
    { width: 390, locale: "en" },
    { width: 1440, locale: "de" },
    { width: 390, locale: "de" },
  ] as const)("keeps the refresh footprint at $width px in $locale", async ({ width, locale }) => {
    await page.viewport(width, 900);
    await i18n.setLocale(locale);
    document.body.append(container);
    const props = createProps();
    render(renderSkills(props), container);
    await document.fonts.ready;

    const button = container.querySelector<HTMLButtonElement>(".plugins-toolbar > button")!;
    const search = container.querySelector<HTMLInputElement>('[name="skills-filter"]')!;
    const group = container.querySelector<HTMLElement>(".skills-group")!;
    const status = container.querySelector<HTMLElement>('.plugins-toolbar > [role="status"]');
    const bounds = () =>
      [button, search, group].map((element) => {
        const { x, y, width: measuredWidth, height } = element.getBoundingClientRect();
        return { x, y, width: measuredWidth, height };
      });
    const idle = bounds();
    expect(button.disabled).toBe(false);

    render(renderSkills({ ...props, loading: true }), container);
    expect(bounds()).toEqual(idle);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await expect
      .element(page.getByRole("button", { name: t("common.refresh"), exact: true }))
      .toBeVisible();
    expect(status?.textContent?.trim()).toBe(t("common.loading"));
    expect(status?.closest('[aria-busy="true"]')).toBeNull();

    render(renderSkills(props), container);
    expect(bounds()).toEqual(idle);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");
    expect(status?.isConnected).toBe(true);
    expect(status?.textContent?.trim()).toBe("");
  });
});
