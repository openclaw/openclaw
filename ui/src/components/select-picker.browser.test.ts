import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderModelPicker } from "./model-picker.ts";
import type { SelectPicker } from "./select-picker.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "../styles/base.css";
import "../styles/settings-controls.css";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("searchable model menu layout", () => {
  it.each([
    { width: 1280, placement: "bottom" as const },
    { width: 390, placement: "top" as const },
  ])("keeps distinct model labels readable at $width pixels", async ({ width, placement }) => {
    const { page } = await import("vitest/browser");
    await page.viewport(width, 844);
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;right:12px;${placement === "top" ? "bottom" : "top"}:32px;width:120px`;
    document.body.append(host);
    const onChange = vi.fn();
    render(
      renderModelPicker({
        label: "Model",
        value: "fixture/anchor",
        placement,
        options: [
          { value: "fixture/anchor", label: "Anchor", provider: "fixture" },
          { value: "fixture/aurora-large", label: "Aurora Large", provider: "fixture" },
          { value: "fixture/aurora-small", label: "Aurora Small", provider: "fixture" },
          ...["Birch", "Cedar", "Delta", "Elm", "Forest", "Granite"].map((label) => ({
            value: `fixture/${label.toLowerCase()}`,
            label,
            provider: "fixture",
          })),
        ],
        onChange,
      }),
      host,
    );
    const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
    await picker.updateComplete;
    await page.getByRole("button", { name: "Model: Anchor", exact: true }).click();
    const row = picker.querySelector<HTMLElement>('[data-value="fixture/aurora-large"]')!;
    await expect.element(row).toBeVisible();
    const label = row.querySelector<HTMLElement>(".picker-select__label")!;
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    const menu = picker.querySelector<HTMLElement>(".picker-select__menu")!;
    const bounds = menu.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(innerWidth);
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
    await page.getByRole("combobox", { name: "Search", exact: true }).fill("Aurora Large");
    expect(onChange).not.toHaveBeenCalled();
    await picker.updateComplete;
    await page
      .elementLocator(picker.querySelector<HTMLElement>('[data-value="fixture/aurora-large"]')!)
      .click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture/aurora-large");
  });

  it.each([
    { width: 1280, placement: "bottom" as const },
    { width: 390, placement: "top" as const },
  ])(
    "keeps compact model and custom labels readable at $width pixels",
    async ({ width, placement }) => {
      const { page, userEvent } = await import("vitest/browser");
      await page.viewport(width, 844);
      const host = document.createElement("div");
      host.style.cssText = `position:fixed;right:12px;${placement === "top" ? "bottom" : "top"}:32px;width:90px`;
      document.body.append(host);
      const onChange = vi.fn();
      render(
        renderModelPicker({
          label: "Model",
          value: "",
          placement,
          options: [
            { value: "", label: "Default" },
            { value: "fixture/anchor", label: "fixture/anchor", provider: "fixture" },
          ],
          custom: { label: "Custom model…" },
          onChange,
        }),
        host,
      );
      const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
      await picker.updateComplete;
      await page.getByRole("button", { name: "Model: Default", exact: true }).click();
      await expect.element(page.getByRole("listbox", { name: "Model", exact: true })).toBeVisible();
      for (const label of picker.querySelectorAll<HTMLElement>(
        "[role=option] .picker-select__label",
      )) {
        expect(label.scrollWidth, label.textContent ?? "").toBeLessThanOrEqual(label.clientWidth);
      }
      expect(picker.querySelector(".picker-select__search")).toBeNull();
      const menu = picker.querySelector<HTMLElement>(".picker-select__menu")!;
      const bounds = menu.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
      await userEvent.keyboard("{ArrowDown}{Enter}");
      expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture/anchor");
    },
  );

  it("displays a saved disabled utility model without making it selectable as primary", async () => {
    const { page, userEvent } = await import("vitest/browser");
    const host = document.createElement("div");
    host.style.cssText = "width:320px;padding:24px";
    document.body.append(host);
    const available = [
      "agent-backup",
      "fallback-one",
      "fallback-two",
      "global-one",
      "global-three",
      "global-two",
    ].map((label) => ({ value: `fixture/${label}`, label }));
    const unavailable = {
      value: "retired/not-offered",
      label: "retired/not-offered",
      disabled: true,
    };
    const utilityChange = vi.fn();
    const primaryChange = vi.fn();
    render(
      html`
        ${renderModelPicker({
          id: "saved-utility",
          label: "Utility Model",
          value: unavailable.value,
          options: [
            { value: "__openclaw_automatic_utility__", label: "Auto" },
            { value: "", label: "Disabled" },
            ...available,
            unavailable,
          ],
          onChange: utilityChange,
        })}
        ${renderModelPicker({
          id: "available-primary",
          label: "Model",
          value: "fixture/global-three",
          options: [
            { value: "", label: "Select a model", disabled: true },
            ...available,
            unavailable,
          ],
          onChange: primaryChange,
        })}
      `,
      host,
    );
    await Promise.all(
      [...host.querySelectorAll<SelectPicker>("openclaw-select-picker")].map(
        (picker) => picker.updateComplete,
      ),
    );
    const utility = page.getByRole("button", {
      name: "Utility Model: retired/not-offered",
      exact: true,
    });
    await expect.element(utility).toBeVisible();
    await utility.click();
    await page.getByRole("combobox", { name: "Search", exact: true }).fill("retired/not-offered");
    await userEvent.keyboard("{Enter}");
    expect(utilityChange).not.toHaveBeenCalled();
    await expect.element(utility).toHaveAccessibleName("Utility Model: retired/not-offered");
    await page.getByRole("combobox", { name: "Search", exact: true }).fill("Auto");
    await userEvent.keyboard("{Enter}");
    expect(utilityChange).toHaveBeenCalledExactlyOnceWith("__openclaw_automatic_utility__");
    await page.getByRole("button", { name: "Model: global-three", exact: true }).click();
    await userEvent.keyboard("{End}{Enter}");
    expect(primaryChange).toHaveBeenCalledExactlyOnceWith("fixture/global-two");
  });

  it("caps an intrinsic compact menu at the phone viewport", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(390, 844);
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;right:12px;top:32px;width:90px";
    document.body.append(host);
    render(
      renderModelPicker({
        label: "Model",
        value: "",
        options: [
          { value: "", label: "Default" },
          {
            value: "fixture/very-long-context-model-reference-for-a-narrow-phone-viewport",
            label: "fixture/very-long-context-model-reference-for-a-narrow-phone-viewport",
          },
        ],
        onChange: vi.fn(),
      }),
      host,
    );
    const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
    await picker.updateComplete;
    await page.getByRole("button", { name: "Model: Default", exact: true }).click();
    await expect.element(page.getByRole("listbox", { name: "Model", exact: true })).toBeVisible();
    const bounds = picker.querySelector(".picker-select__menu")!.getBoundingClientRect();
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(innerWidth);
    expect(bounds.width).toBeGreaterThan(90);
  });

  it.each([390, 1280])(
    "keeps the page still when a positioned menu reopens from %i pixels",
    async (initialWidth) => {
      const { page, userEvent } = await import("vitest/browser");
      await page.viewport(initialWidth, 844);
      const host = document.createElement("div");
      host.style.cssText =
        "width:min(320px,calc(100vw - 48px));margin-inline:auto 24px;margin-top:300px";
      document.body.append(host);
      const onChange = vi.fn();
      render(
        renderModelPicker({
          label: "Model",
          value: "fixture/anchor",
          options: [
            "anchor",
            "aurora-large",
            "aurora-small",
            "birch",
            "cedar",
            "delta",
            "elm",
            "forest",
            "granite",
          ].map((id) => ({ value: "fixture/" + id, label: id })),
          onChange,
        }),
        host,
      );
      const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
      await picker.updateComplete;
      const trigger = page.getByRole("button", { name: "Model: anchor", exact: true });
      await trigger.click();
      await expect
        .element(page.getByRole("combobox", { name: "Search", exact: true }))
        .toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      await page.viewport(390, 844);
      expect(scrollX).toBe(0);
      await trigger.click();
      const search = page.getByRole("combobox", { name: "Search", exact: true });
      await expect.element(search).toHaveFocus();
      const bounds = picker.querySelector("button")!.getBoundingClientRect();
      expect(scrollX).toBe(0);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("keeps a short menu fitted to its trigger", async () => {
    const { page } = await import("vitest/browser");
    await page.viewport(390, 844);
    const host = document.createElement("div");
    host.style.cssText = "width:160px;padding:24px";
    document.body.append(host);
    render(
      renderModelPicker({
        label: "Model",
        value: "auto",
        options: [
          { value: "auto", label: "Auto" },
          { value: "off", label: "Off" },
        ],
        onChange: vi.fn(),
      }),
      host,
    );
    const picker = host.querySelector<SelectPicker>("openclaw-select-picker")!;
    await picker.updateComplete;
    const trigger = page.getByRole("button", { name: "Model: Auto", exact: true });
    await trigger.click();
    await expect.element(page.getByRole("option", { name: "Off", exact: true })).toBeVisible();
    expect(picker.querySelector("input")).toBeNull();
    const menu = picker.querySelector<HTMLElement>(".picker-select__menu")!;
    expect(menu.getBoundingClientRect().width).toBeCloseTo(
      picker.querySelector("button")!.getBoundingClientRect().width,
      0,
    );
  });
});
