import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { normalizeAgentModelRefForConfig } from "../../../src/config/model-input.js";
import { createPrimaryModelExclusion } from "../lib/agents/display.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { MultiSelect } from "./multi-select.tsx";
type MultiSelectInput = Parameters<typeof MultiSelect>[0];
type MultiSelectOption = NonNullable<MultiSelectInput["options"]>[number];
const primary = "openai/gpt-5.4";
const sonnet = "anthropic/claude-sonnet-4-6";
const opus = "anthropic/claude-opus-4-7";
const gemini = "google/gemini-3-pro";
const options: MultiSelectOption[] = [
  { value: primary, label: "GPT-5.4", provider: "openai" },
  { value: sonnet, label: "Claude Sonnet 4.6", provider: "anthropic" },
  { value: opus, label: "Claude Opus 4.7", provider: "anthropic" },
  { value: gemini, label: "Gemini 3 Pro", provider: "google" },
];
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function fixtureOptions(...rows: Array<[string, string, boolean?]>): MultiSelectOption[] {
  return rows.map(([value, label, disabled]) => ({ value: `fixture/${value}`, label, disabled }));
}
function createFixture(rows: Array<[string, string, boolean?]>, value: string[] = []) {
  return createMultiSelect({ options: fixtureOptions(...rows), value, isExcluded: () => false });
}
async function createMultiSelect(overrides: MultiSelectInput = {}) {
  const props = {
    options,
    value: [sonnet],
    isExcluded: (value: string) => value === primary,
    placeholder: "Add fallback…",
    allowCustom: true,
    onChange: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  };
  const container = document.body.appendChild(document.createElement("div"));
  const view = mountSolid(MultiSelect, props, container);
  const element = container.querySelector<HTMLElement>("openclaw-multi-select")!;
  await waitForSolid(() => expect(element.querySelector("input")).not.toBeNull());
  return {
    element,
    props,
    update: (next: MultiSelectInput) => view.update({ ...props, ...next }),
  };
}
function input(element: HTMLElement): HTMLInputElement {
  return element.querySelector<HTMLInputElement>("input.multi-select__input")!;
}
function highlighted(element: HTMLElement) {
  return element.querySelector('[aria-selected="true"]')?.getAttribute("data-value");
}
function values(element: HTMLElement, kind: "option" | "chip") {
  return Array.from(element.querySelectorAll(`.multi-select__${kind}`), (node) =>
    node.getAttribute("data-value"),
  );
}
function isOpen(element: HTMLElement): boolean {
  return input(element).getAttribute("aria-expanded") === "true";
}
async function typeText(element: HTMLElement, text: string) {
  await userEvent.fill(input(element), text);
  flush();
}
async function pressKey(element: HTMLElement, key: string) {
  input(element).focus();
  await userEvent.keyboard(key.length === 1 ? key : `{${key}}`);
  flush();
}
async function clickField(element: HTMLElement) {
  element
    .querySelector(".multi-select")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  flush();
}
it("does not commit a disabled choice but keeps available choices usable", async () => {
  const { element, props } = await createFixture([
    ["blocked", "Blocked", true],
    ["ready", "Ready"],
  ]);
  await clickField(element);
  const blocked = element.querySelector<HTMLElement>('[data-value="fixture/blocked"]');
  blocked?.click();
  expect(props.onChange).not.toHaveBeenCalled();
  expect(blocked?.getAttribute("aria-disabled")).toBe("true");
  await pressKey(element, "Enter");
  await waitForSolid(() => expect(props.onChange).toHaveBeenCalledWith(["fixture/ready"]));
});
it.each(["content", "trigger"])(
  "keeps the highlighted %s value distinct from listbox structure",
  async (value) => {
    const { element, props } = await createMultiSelect({
      value: [],
      isExcluded: () => false,
      options: [{ value, label: value }],
    });
    await clickField(element);
    await waitForSolid(() => {
      expect(input(element).getAttribute("aria-activedescendant")).toBeTruthy();
    });
    const activeId = input(element).getAttribute("aria-activedescendant");
    const active = activeId ? document.getElementById(activeId) : null;
    expect(active?.getAttribute("role")).toBe("option");
    expect(active?.getAttribute("data-value")).toBe(value);
    await pressKey(element, "Enter");
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith([value]);
  },
);
it("keeps disabled choices out of typed additions without discarding saved chips", async () => {
  const { element, props } = await createFixture(
    [
      ["saved", "Saved", true],
      ["blocked", "Blocked", true],
      ["ready", "Ready"],
    ],
    ["fixture/saved"],
  );
  await typeText(element, "fixture/blocked, fixture/ready");
  await pressKey(element, ",");
  expect(props.onChange).toHaveBeenCalledWith(["fixture/saved", "fixture/ready"]);
  expect(values(element, "chip")).toEqual(["fixture/saved"]);
  element.querySelector<HTMLButtonElement>(".chip-remove")?.click();
  expect(props.onChange).toHaveBeenLastCalledWith([]);
});
it("skips disabled choices in both keyboard directions", async () => {
  const { element, props } = await createFixture([
    ["first", "First"],
    ["blocked", "Blocked", true],
    ["last", "Last"],
  ]);
  await clickField(element);
  await waitForSolid(() => expect(highlighted(element)).toBe("fixture/first"));
  await pressKey(element, "ArrowDown");
  expect(document.activeElement).toBe(input(element));
  expect(highlighted(element)).toBe("fixture/last");
  await pressKey(element, "ArrowUp");
  expect(highlighted(element)).toBe("fixture/first");
  await pressKey(element, "ArrowUp");
  await pressKey(element, "Enter");
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith(["fixture/last"]);
});
it("removes chips with Backspace on empty text and with the chip button", async () => {
  const { element, props } = await createMultiSelect({ value: [sonnet, gemini] });
  await pressKey(element, "Backspace");
  expect(props.onChange).toHaveBeenLastCalledWith([sonnet]);
  element.querySelector<HTMLButtonElement>(".multi-select__chip .chip-remove")?.click();
  expect(props.onChange).toHaveBeenLastCalledWith([gemini]);
});
it("closes on Escape and clears the unconfirmed query", async () => {
  const { element, props } = await createMultiSelect();
  await pressKey(element, "Enter");
  expect(props.onChange).not.toHaveBeenCalled();
  await pressKey(element, "ArrowDown");
  expect(isOpen(element)).toBe(true);
  await typeText(element, "op");
  await pressKey(element, "Escape");
  expect(isOpen(element)).toBe(false);
  expect(input(element).value).toBe("");
  await pressKey(element, "Enter");
  expect(props.onChange).not.toHaveBeenCalled();
});
it("keeps native Tab exit from the highlighted listbox", async () => {
  const { element, props } = await createMultiSelect();
  const outside = document.createElement("input");
  document.body.append(outside);
  await clickField(element);
  await pressKey(element, "ArrowDown");
  await userEvent.keyboard("{Tab}");
  flush();
  expect(document.activeElement).toBe(outside);
  expect(isOpen(element)).toBe(false);
  expect(props.onChange).not.toHaveBeenCalled();
});
it("discards unconfirmed search text on blur", async () => {
  const outside = document.createElement("button");
  document.body.append(outside);
  for (const value of ["gem", "openrouter/pending", gemini]) {
    const { element, props } = await createMultiSelect();
    input(element).focus();
    await typeText(element, value);
    outside.focus();
    await waitForSolid(() => expect(isOpen(element)).toBe(false));
    expect(props.onChange).not.toHaveBeenCalled();
    expect(values(element, "chip")).toEqual([sonnet]);
    expect(input(element).value).toBe("");
  }
});
it("preserves explicitly confirmed alias bindings on Enter", async () => {
  const target = "custom/Model-A";
  const { element, props } = await createMultiSelect({
    options: [{ value: target, label: "Uppercase model" }],
    value: [],
    isExcluded: createPrimaryModelExclusion(
      { agents: { defaults: { models: { [target]: { alias: "backup" } } } } },
      primary,
    ),
    getValueKey: normalizeAgentModelRefForConfig,
  });
  await typeText(element, `backup, ${target}`);
  await pressKey(element, "Enter");
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith(["backup", target]);
});
it("keeps a bare fallback separate from a real alternate model", async () => {
  const existing = "gpt-5.4-mini";
  const alternate = "local/gpt-5.4-mini";
  const models = { [alternate]: {} };
  const { element, props } = await createMultiSelect({
    options: [{ value: alternate, label: "Alternate model" }],
    value: [existing],
    isExcluded: createPrimaryModelExclusion(
      { agents: { defaults: { model: { primary }, models } } },
      primary,
    ),
    getValueKey: normalizeAgentModelRefForConfig,
  });
  await clickField(element);
  expect(values(element, "option")).toEqual([alternate]);
  await pressKey(element, "Enter");
  await waitForSolid(() =>
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith([existing, alternate]),
  );
});
it("selects the visible highlight when a catalog refresh shortens the open list", async () => {
  const { element, props, update } = await createMultiSelect();
  await pressKey(element, "ArrowDown");
  await pressKey(element, "ArrowDown");
  update({ options: options.filter((option) => option.value !== gemini) });
  flush();
  await waitForSolid(() => expect(highlighted(element)).toBe(opus));
  await pressKey(element, "Enter");
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith([sonnet, opus]);
});
it("finds and selects a model by its displayed description", async () => {
  const { element, props } = await createMultiSelect({
    options: [{ value: "fixture/backup", label: "Backup", description: "Cafe\u0301 endpoint" }],
    value: [],
    allowCustom: false,
  });
  await typeText(element, "Café");
  expect(values(element, "option")).toEqual(["fixture/backup"]);
  expect(element.querySelector(".picker-select__description")?.textContent).toBe(
    "Cafe\u0301 endpoint",
  );
  await pressKey(element, "Enter");
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith(["fixture/backup"]);
});
it("leaves composing input untouched until the operator confirms the completed value", async () => {
  const { element, props } = await createMultiSelect();
  await typeText(element, "local/模型");
  input(element).dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  flush();
  expect(props.onChange).not.toHaveBeenCalled();
  expect(input(element).value).toBe("local/模型");
  await pressKey(element, "Enter");
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith([sonnet, "local/模型"]);
});
it("stays inert while disabled", async () => {
  const { element, props } = await createMultiSelect({ disabled: true });
  expect(input(element).disabled).toBe(true);
  expect(element.querySelector<HTMLButtonElement>(".chip-remove")?.disabled).toBe(true);
  await clickField(element);
  expect(isOpen(element)).toBe(false);
  expect(props.onOpen).not.toHaveBeenCalled();
});

it("keeps the scroll position when the pointer highlights a clipped edge row", async () => {
  const { element } = await createMultiSelect({
    options: Array.from({ length: 60 }, (_, index) => ({
      value: `fixture/model-${index}`,
      label: `Model ${index}`,
    })),
    value: [],
  });
  const settle = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  await userEvent.click(input(element));
  const list = element.querySelector<HTMLElement>(".multi-select__menu")!;
  await waitForSolid(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
  const rows = [...element.querySelectorAll<HTMLElement>(".multi-select__option")];
  // Opening reveals the initial highlight; finish that scroll before simulating a wheel scroll.
  await waitForSolid(() => expect(rows[0]!.getAttribute("aria-selected")).toBe("true"));
  const bounds = list.getBoundingClientRect();
  const rowHeight = rows[1]!.offsetTop - rows[0]!.offsetTop;
  // Leave half a row clipped at the bottom edge, as a wheel or trackpad scroll does.
  const edgeRow = rows.find((row) => row.offsetTop + rowHeight > list.clientHeight * 3)!;
  list.scrollTop = edgeRow.offsetTop + rowHeight / 2 - list.clientHeight;
  await settle();
  const top = list.scrollTop;
  const rect = edgeRow.getBoundingClientRect();
  expect(rect.top).toBeLessThan(bounds.bottom);
  expect(rect.bottom).toBeGreaterThan(bounds.bottom);
  // Hover the menu at the clipped row's visible sliver; hovering the row
  // itself would let Playwright scroll it into view before moving.
  await userEvent.hover(list, {
    position: { x: 24, y: Math.round((rect.top + bounds.bottom) / 2 - bounds.top) },
  });
  await waitForSolid(() => expect(edgeRow.hasAttribute("data-highlighted")).toBe(true));
  await settle();
  expect(list.scrollTop).toBe(top);
  // Keyboard navigation after a pointer highlight still reveals the next row.
  await pressKey(element, "ArrowDown");
  await waitForSolid(() => expect(list.scrollTop).toBeGreaterThan(top));
});
