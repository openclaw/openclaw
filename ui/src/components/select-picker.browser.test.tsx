import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { Picker, type SelectPicker } from "./select-picker.ts";
import { DecisionModelPicker } from "./solid/decision-model-picker.tsx";
import {
  ModelPicker,
  type ModelPickerOption,
  type ModelPickerParams,
} from "./solid/model-picker.tsx";
import { SettingsRow } from "./solid/settings-ui.tsx";
import "../styles/base.css";
import "../styles/settings-controls.css";
import "../styles/settings.css";

afterEach(async () => {
  cleanupSolid();
  document.body.replaceChildren();
  await Promise.resolve();
});

function option(value: string, label = value): ModelPickerOption {
  return { value, label };
}

function numberedModels(length: number) {
  return Array.from({ length }, (_, index) => option(`fixture/model-${index}`, `Model ${index}`));
}

const modelLabels = "Anchor,Aurora Large,Aurora Small,Birch,Cedar,Delta,Elm,Forest,Granite".split(
  ",",
);
const readableModels = modelLabels.map((label) => ({
  value: `fixture/${label.toLowerCase().replaceAll(" ", "-")}`,
  label,
  provider: "fixture",
}));

async function browser(width?: number) {
  const { page, userEvent } = await import("vitest/browser");
  if (width !== undefined) {
    await page.viewport(width, 844);
  }
  const role = (kind: Parameters<typeof page.getByRole>[0], name: string) =>
    page.getByRole(kind, { name, exact: true });
  return { page, userEvent, role };
}

function labelsFit(picker: SelectPicker) {
  for (const label of picker.querySelectorAll<HTMLElement>("[role=option] .picker-select__label")) {
    expect(label.scrollWidth, label.textContent ?? "").toBeLessThanOrEqual(label.clientWidth);
  }
}

type ModelExtras = Pick<ModelPickerParams, "placement" | "custom">;
async function mountModel(options: ModelPickerOption[], style: string, extra: ModelExtras = {}) {
  const onChange = vi.fn();
  const params = { value: options[0]!.value, options, ...extra };
  const { picker } = await mountPickers(
    () => <ModelPicker label="Model" onChange={onChange} {...params} />,
    style,
  );
  return { picker, onChange };
}

async function mountPickers(content: () => JSX.Element, style = "", direction = "") {
  const host = document.body.appendChild(document.createElement("div"));
  host.style.cssText = style;
  host.dir = direction;
  mountSolid(content, { container: host });
  const pickers = [...host.querySelectorAll<SelectPicker>("openclaw-select-picker")];
  await Promise.all(pickers.map((picker) => picker.updateComplete));
  return { host, pickers, picker: pickers[0]! };
}

function menuCase(
  sizing: "custom" | "viewport" | "trigger" | "wrap" | "search",
  options: ModelPickerOption[],
  width = 390,
  style = "position:fixed;right:12px;top:32px;width:90px",
  extra: ModelExtras = {},
) {
  return {
    sizing,
    width,
    style,
    selected: options[0]!.label,
    options,
    extra,
  };
}

describe.runIf("__vitest_browser__" in globalThis)("searchable model menu layout", () => {
  it("reveals keyboard highlights without untracked reactive reads", async () => {
    const warning = vi.spyOn(console, "warn");
    onTestFinished(() => warning.mockRestore());
    const { userEvent, role } = await browser(1280);
    const { picker, onChange } = await mountModel(numberedModels(30), "width:240px;margin:24px");
    await role("button", "Model: Model 0").click();
    await userEvent.keyboard("{ArrowUp}");
    const list = picker.querySelector<HTMLElement>(".picker-select__options")!;
    const last = picker.querySelector<HTMLElement>('[data-value="fixture/model-29"]')!;
    await expect.poll(() => last.hasAttribute("data-active")).toBe(true);
    await expect.poll(() => list.scrollTop).toBeGreaterThan(0);
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      list.getBoundingClientRect().bottom + 1,
    );
    const end = list.scrollHeight - list.clientHeight;
    for (const [top, fadeStart, fadeEnd] of [
      [0, false, true],
      [1, true, true],
      [end - 2, true, true],
      [end - 1, true, false],
    ] as const) {
      list.scrollTop = top;
      list.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      expect(list.scrollTop).toBe(top);
      expect(last.hasAttribute("data-active")).toBe(true);
      expect(list.hasAttribute("data-fade-start")).toBe(fadeStart);
      expect(list.hasAttribute("data-fade-end")).toBe(fadeEnd);
      expect(onChange).not.toHaveBeenCalled();
    }
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture/model-0");
    expect(warning.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
  });

  it.each([undefined, "submenu"] as const)(
    "resolves writing direction on opening without reading closed picker styles (%s)",
    async (variant) => {
      const { userEvent } = await import("vitest/browser");
      const computedStyle = vi.spyOn(window, "getComputedStyle");
      onTestFinished(() => computedStyle.mockRestore());
      const [direction, setDirection] = createSignal<"ltr" | "rtl">("ltr");
      const [placement, setPlacement] = createSignal<"top" | "bottom">("bottom");
      const { picker } = await mountPickers(() => (
        <div dir={direction()}>
          <Picker
            params={{
              label: "Submenu",
              value: "one",
              options: [{ value: "one", label: "One" }],
              variant,
              placement: placement(),
              onChange() {},
            }}
          />
        </div>
      ));
      const menu = picker.querySelector<HTMLElement>(".picker-select__menu")!;
      const hostStyleReads = () =>
        computedStyle.mock.calls.filter(([element]) => element === picker);
      expect(hostStyleReads()).toHaveLength(0);

      setDirection("rtl");
      setPlacement("top");
      flush();
      await picker.updateComplete;
      expect(hostStyleReads()).toHaveLength(0);
      const trigger = picker.querySelector<HTMLButtonElement>("button")!;
      trigger.focus();
      await userEvent.keyboard(variant === "submenu" ? "{ArrowLeft}" : "{ArrowDown}");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      expect(menu.dataset.placement).toBe(variant === "submenu" ? "left-start" : "top-start");
      expect(getComputedStyle(menu).direction).toBe("rtl");

      setDirection("ltr");
      setPlacement("bottom");
      flush();
      await picker.updateComplete;
      expect(menu.dataset.placement).toBe(variant === "submenu" ? "right-start" : "bottom-start");
      await userEvent.keyboard("{Escape}");
      computedStyle.mockClear();
      setDirection("rtl");
      setPlacement("top");
      flush();
      await picker.updateComplete;
      expect(hostStyleReads()).toHaveLength(0);
      await userEvent.keyboard(variant === "submenu" ? "{ArrowLeft}" : "{ArrowDown}");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      expect(menu.dataset.placement).toBe(variant === "submenu" ? "left-start" : "top-start");
      await userEvent.keyboard(variant === "submenu" ? "{ArrowRight}" : "{Escape}");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    },
  );

  it.each([
    { width: 1280, direction: "ltr" },
    { width: 390, direction: "ltr" },
    { width: 1280, direction: "rtl" },
    { width: 390, direction: "rtl" },
  ])(
    "starts picker searches at the writing edge in $direction at $width pixels",
    async ({ width, direction }) => {
      const { page, userEvent } = await browser(width);
      const options = numberedModels(9);
      const onChange = vi.fn();
      const selection = { value: "fixture/model-0", options, onChange };
      const Shared = () => <Picker params={{ label: "Shared", searchable: true, ...selection }} />;
      const { host, pickers } = await mountPickers(
        () => (
          <>
            <SettingsRow title="Primary" control={<ModelPicker label="Primary" {...selection} />} />
            <SettingsRow
              title="Decision"
              control={
                <DecisionModelPicker
                  id="alignment-decision"
                  models={[
                    { provider: "fixture", id: "one", name: "Decision one", pluginId: "fixture" },
                  ]}
                  value="fixture/one"
                  disabled={false}
                  onChange={onChange}
                />
              }
            />
            <SettingsRow title="Shared" control={<Shared />} />
            <Shared />
            <SettingsRow
              title="Value"
              control={
                <>
                  <input class="settings-input" aria-label="Value" value="42" />
                  <span class="settings-secret">
                    <input class="settings-input" aria-label="Nested value" value="example" />
                  </span>
                </>
              }
            />
          </>
        ),
        "",
        direction,
      );
      for (const picker of pickers) {
        const trigger = picker.querySelector<HTMLButtonElement>("button")!;
        await page.elementLocator(trigger).click();
        const search = picker.querySelector<HTMLInputElement>('input[role="combobox"]')!;
        await expect.element(search).toHaveFocus();
        expect(getComputedStyle(search).direction).toBe(direction);
        expect(getComputedStyle(search).textAlign).toBe("start");
        await page.elementLocator(search).fill("one");
        expect(getComputedStyle(search).textAlign).toBe("start");
        await userEvent.keyboard("{Escape}");
        await expect.element(trigger).toHaveFocus();
      }
      for (const label of ["Value", "Nested value"]) {
        const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
        expect(getComputedStyle(input).textAlign).toBe("right");
      }
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    ...(["bottom", "top"] as const).map((placement) =>
      menuCase(
        "search",
        readableModels,
        placement === "bottom" ? 1280 : 390,
        `position:fixed;right:12px;${placement === "top" ? "bottom" : "top"}:32px;width:120px`,
        { placement },
      ),
    ),
    ...(["bottom", "top"] as const).map((placement) =>
      menuCase(
        "custom",
        [option("", "Default"), { ...option("fixture/anchor"), provider: "fixture" }],
        placement === "bottom" ? 1280 : 390,
        `position:fixed;right:12px;${placement === "top" ? "bottom" : "top"}:32px;width:90px`,
        { placement, custom: { label: "Custom model…" } },
      ),
    ),
    menuCase("viewport", [
      option("", "Default"),
      option("fixture/very-long-context-model-reference-for-a-narrow-phone-viewport"),
    ]),
    menuCase(
      "trigger",
      [option("auto", "Auto"), option("off", "Off")],
      390,
      "width:160px;padding:24px",
    ),
    menuCase(
      "wrap",
      ["0528", "distill"].map((suffix) => ({
        value: `deepseek/deepseek-r1-${suffix}`,
        label: `DeepSeek: DeepSeek-R1-${suffix === "distill" ? "Distill" : suffix}`,
        provider: "deepseek",
      })),
      390,
      "position:fixed;right:12px;top:32px;width:120px",
    ),
  ])(
    "keeps compact model menus readable: $sizing at $width pixels",
    async ({ width, style, options, extra, selected, sizing }) => {
      const { page, userEvent, role } = await browser(width);
      const { picker, onChange } = await mountModel(options, style, extra);
      await role("button", `Model: ${selected}`).click();
      if (sizing === "trigger") {
        await expect.element(role("option", "Off")).toBeVisible();
        expect(picker.querySelector("input")).toBeNull();
      } else if (sizing !== "wrap") {
        await expect.element(role("listbox", "Model")).toBeVisible();
      }
      const bounds = picker.querySelector(".picker-select__menu")!.getBoundingClientRect();
      if (sizing === "custom" || sizing === "viewport" || sizing === "search") {
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      }
      if (sizing === "search") {
        const row = picker.querySelector<HTMLElement>('[data-value="fixture/aurora-large"]')!;
        await expect.element(row).toBeVisible();
        const label = row.querySelector<HTMLElement>(".picker-select__label")!;
        expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
        await role("combobox", "Search").fill("Aurora Large");
        expect(onChange).not.toHaveBeenCalled();
        await picker.updateComplete;
        expect(
          picker.querySelector<HTMLElement>('[data-value="fixture/anchor"]')?.checkVisibility() ??
            false,
        ).toBe(false);
        await page
          .elementLocator(picker.querySelector<HTMLElement>('[data-value="fixture/aurora-large"]')!)
          .click();
        expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture/aurora-large");
        return;
      }
      if (sizing === "viewport") {
        expect(bounds.width).toBeGreaterThan(90);
      } else if (sizing === "trigger") {
        expect(bounds.width).toBeCloseTo(
          picker.querySelector("button")!.getBoundingClientRect().width,
          0,
        );
      } else {
        if (sizing === "wrap") {
          for (const label of picker.querySelectorAll<HTMLElement>(
            "[role=option] .picker-select__label",
          )) {
            expect(getComputedStyle(label).whiteSpace).toBe("normal");
          }
        } else {
          labelsFit(picker);
        }
        if (sizing === "custom") {
          expect(picker.querySelector(".picker-select__search")).toBeNull();
          expect(bounds.top).toBeGreaterThanOrEqual(0);
          expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
          await userEvent.keyboard("{ArrowDown}{Enter}");
          expect(onChange).toHaveBeenCalledExactlyOnceWith("fixture/anchor");
        }
      }
    },
  );

  it("displays a saved disabled utility model without making it selectable as primary", async () => {
    const { role, userEvent } = await browser();
    const available = "agent-backup fallback-one fallback-two global-one global-three global-two"
      .split(" ")
      .map((label) => option(`fixture/${label}`, label));
    const unavailable = {
      value: "retired/not-offered",
      label: "retired/not-offered",
      disabled: true,
    };
    const utilityChange = vi.fn();
    const primaryChange = vi.fn();
    await mountPickers(
      () => (
        <>
          <ModelPicker
            id="saved-utility"
            label="Utility Model"
            value={unavailable.value}
            options={[
              { value: "__openclaw_automatic_utility__", label: "Auto" },
              { value: "", label: "Disabled" },
              ...available,
              unavailable,
            ]}
            onChange={utilityChange}
          />
          <ModelPicker
            id="available-primary"
            label="Model"
            value="fixture/global-three"
            options={[
              { value: "", label: "Select a model", disabled: true },
              ...available,
              unavailable,
            ]}
            onChange={primaryChange}
          />
        </>
      ),
      "width:320px;padding:24px",
    );
    const utility = role("button", "Utility Model: retired/not-offered");
    await expect.element(utility).toBeVisible();
    await utility.click();
    await role("combobox", "Search").fill("retired/not-offered");
    await userEvent.keyboard("{Enter}");
    expect(utilityChange).not.toHaveBeenCalled();
    await expect.element(utility).toHaveAccessibleName("Utility Model: retired/not-offered");
    await role("combobox", "Search").fill("Auto");
    await userEvent.keyboard("{Enter}");
    expect(utilityChange).toHaveBeenCalledExactlyOnceWith("__openclaw_automatic_utility__");
    await role("button", "Model: global-three").click();
    await userEvent.keyboard("{End}{Enter}");
    expect(primaryChange).toHaveBeenCalledExactlyOnceWith("fixture/global-two");
  });

  it.each([390, 1280])(
    "keeps the page still when a positioned menu reopens from %i pixels",
    async (initialWidth) => {
      const { page, userEvent, role } = await browser(initialWidth);
      const { picker, onChange } = await mountModel(
        modelLabels.map((label) => {
          const id = label.toLowerCase().replaceAll(" ", "-");
          return option("fixture/" + id, id);
        }),
        "width:min(320px,calc(100vw - 48px));margin-inline:auto 24px;margin-top:300px",
      );
      const trigger = role("button", "Model: anchor");
      await trigger.click();
      await expect.element(role("combobox", "Search")).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      await page.viewport(390, 844);
      expect(scrollX).toBe(0);
      await trigger.click();
      const search = role("combobox", "Search");
      await expect.element(search).toHaveFocus();
      const bounds = picker.querySelector("button")!.getBoundingClientRect();
      expect(scrollX).toBe(0);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it.each([390, 1280])(
    "fits grouped decisions and supports native header keyboard controls at %i pixels",
    async (width) => {
      const { userEvent, role } = await browser(width);
      const onChange = vi.fn();
      const [value, setValue] = createSignal("alpha/one");
      const { picker } = await mountPickers(
        () => (
          <>
            <DecisionModelPicker
              id="decisions"
              models={[
                { provider: "alpha", id: "one", name: "Alpha decision model", pluginId: "alpha" },
                { provider: "beta", id: "two", name: "Beta decision model", pluginId: "beta" },
              ]}
              value={value()}
              disabled={false}
              onChange={onChange}
            />
            <input id="after-picker" aria-label="Next field" />
          </>
        ),
        "position:fixed;right:12px;top:32px;width:90px",
      );
      let trigger = role("button", "Decision Model: Alpha decision model");
      await trigger.click();
      const search = role("combobox", "Search");
      await expect.element(search).toHaveFocus();
      const alpha = role("button", "Alpha 1");
      await userEvent.keyboard("{Tab}");
      await expect.element(alpha).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect.element(alpha).toHaveAttribute("aria-expanded", "false");
      expect(onChange).not.toHaveBeenCalled();
      await userEvent.keyboard(" ");
      await expect.element(alpha).toHaveAttribute("aria-expanded", "true");
      const menu = picker.querySelector<HTMLElement>(".picker-select__menu")!;
      const bounds = menu.getBoundingClientRect();
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(innerWidth);
      expect(bounds.bottom).toBeLessThanOrEqual(innerHeight);
      labelsFit(picker);
      setValue("beta/two");
      flush();
      await picker.updateComplete;
      trigger = role("button", "Decision Model: Beta decision model");
      expect(document.activeElement).toBe(
        picker.querySelector('[role="group"][aria-label="Beta"] button'),
      );
      await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
      expect(onChange).not.toHaveBeenCalled();
      await userEvent.keyboard("{Tab}{Tab}");
      await expect.element(role("textbox", "Next field")).toHaveFocus();
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      expect(onChange).not.toHaveBeenCalled();
      await trigger.click();
      await search.fill("beta");
      await expect.element(role("option", "Beta decision model")).toBeVisible();
      await userEvent.keyboard("{Enter}");
      expect(onChange).toHaveBeenCalledExactlyOnceWith("beta/two");
      await expect.element(trigger).toHaveFocus();
    },
  );
});
