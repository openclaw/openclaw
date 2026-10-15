import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { normalizeAgentModelRefForConfig } from "../../../src/config/model-input.js";
import { createPrimaryModelExclusion } from "../lib/agents/display.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import type { MultiSelectOption, MultiSelectProps } from "./multi-select-types.ts";
import { MultiSelect } from "./multi-select.tsx";

type MultiSelectElement = HTMLElement;

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

async function createMultiSelect(overrides: Partial<MultiSelectProps> = {}) {
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
    update: (next: Partial<MultiSelectProps>) => view.update({ ...props, ...next }),
  };
}

function input(element: MultiSelectElement): HTMLInputElement {
  const found = element.querySelector<HTMLInputElement>("input.multi-select__input");
  if (!found) {
    throw new Error("multi-select input missing");
  }
  return found;
}

function rowValues(element: MultiSelectElement): Array<string | null> {
  return Array.from(element.querySelectorAll(".multi-select__option")).map((row) =>
    row.getAttribute("data-value"),
  );
}

function chipValues(element: MultiSelectElement): Array<string | null> {
  return Array.from(element.querySelectorAll(".multi-select__chip")).map((chip) =>
    chip.getAttribute("data-value"),
  );
}

function isOpen(element: MultiSelectElement): boolean {
  return input(element).getAttribute("aria-expanded") === "true";
}

async function typeText(element: MultiSelectElement, text: string) {
  await userEvent.fill(input(element), text);
  flush();
}

async function pressKey(element: MultiSelectElement, key: string) {
  input(element).focus();
  await userEvent.keyboard(key.length === 1 ? key : `{${key}}`);
  flush();
}

async function clickField(element: MultiSelectElement) {
  element
    .querySelector(".multi-select")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  flush();
}

it("does not commit a disabled choice but keeps available choices usable", async () => {
  const { element, props } = await createMultiSelect({
    value: [],
    isExcluded: () => false,
    options: [
      { value: "fixture/blocked", label: "Blocked", disabled: true },
      { value: "fixture/ready", label: "Ready" },
    ],
  });
  await clickField(element);
  const blocked = element.querySelector<HTMLElement>('[data-value="fixture/blocked"]');
  blocked?.click();
  expect(props.onChange).not.toHaveBeenCalled();
  expect(blocked?.getAttribute("aria-disabled")).toBe("true");

  await pressKey(element, "Enter");
  expect(props.onChange).toHaveBeenCalledWith(["fixture/ready"]);
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
  const { element, props } = await createMultiSelect({
    value: ["fixture/saved"],
    isExcluded: () => false,
    options: [
      { value: "fixture/saved", label: "Saved", disabled: true },
      { value: "fixture/blocked", label: "Blocked", disabled: true },
      { value: "fixture/ready", label: "Ready" },
    ],
  });
  await typeText(element, "fixture/blocked, fixture/ready");
  await pressKey(element, ",");
  expect(props.onChange).toHaveBeenCalledWith(["fixture/saved", "fixture/ready"]);
  expect(chipValues(element)).toEqual(["fixture/saved"]);
  element.querySelector<HTMLButtonElement>(".chip-remove")?.click();
  expect(props.onChange).toHaveBeenLastCalledWith([]);
});

it("skips disabled choices in both keyboard directions", async () => {
  const { element, props } = await createMultiSelect({
    value: [],
    isExcluded: () => false,
    options: [
      { value: "fixture/first", label: "First" },
      { value: "fixture/blocked", label: "Blocked", disabled: true },
      { value: "fixture/last", label: "Last" },
    ],
  });
  await clickField(element);
  await pressKey(element, "ArrowDown");
  expect(document.activeElement).toBe(input(element));
  expect(element.querySelector('[aria-selected="true"]')?.getAttribute("data-value")).toBe(
    "fixture/last",
  );
  await pressKey(element, "ArrowUp");
  expect(element.querySelector('[aria-selected="true"]')?.getAttribute("data-value")).toBe(
    "fixture/first",
  );
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

it("moves the highlight with arrow keys and closes on Escape", async () => {
  const { element, props } = await createMultiSelect();

  await pressKey(element, "Enter");
  expect(props.onChange).not.toHaveBeenCalled();
  await pressKey(element, "ArrowDown");
  expect(isOpen(element)).toBe(true);
  await pressKey(element, "ArrowDown");
  const highlighted = () =>
    Array.from(element.querySelectorAll(".multi-select__option")).findIndex(
      (row) => row.getAttribute("aria-selected") === "true",
    );
  expect(highlighted()).toBe(1);
  await pressKey(element, "ArrowUp");
  expect(highlighted()).toBe(0);

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
    expect(chipValues(element)).toEqual([sonnet]);
    expect(input(element).value).toBe("");
  }
});

it.each(["Enter"])("preserves explicitly confirmed alias bindings on %s", async (action) => {
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

  await typeText(element, action === "," ? "backup" : `backup, ${target}`);
  await pressKey(element, action);

  expect(props.onChange).toHaveBeenCalledExactlyOnceWith(
    action === "," ? ["backup"] : ["backup", target],
  );
});

it.each([
  {
    name: "a bare fallback",
    existing: "gpt-5.4-mini",
    alternate: "local/gpt-5.4-mini",
    models: { "local/gpt-5.4-mini": {} },
  },
])("keeps $name separate from a real alternate model", async ({ existing, alternate, models }) => {
  const primaryModelRef = "openai/gpt-5.4";
  const { element, props } = await createMultiSelect({
    options: [{ value: alternate, label: "Alternate model" }],
    value: [existing],
    isExcluded: createPrimaryModelExclusion(
      { agents: { defaults: { model: { primary: primaryModelRef }, models } } },
      primaryModelRef,
    ),
    getValueKey: normalizeAgentModelRefForConfig,
  });

  await clickField(element);
  expect(rowValues(element)).toEqual([alternate]);
  await pressKey(element, "Enter");

  expect(props.onChange).toHaveBeenCalledExactlyOnceWith([existing, alternate]);
});

it("selects the visible highlight when a catalog refresh shortens the open list", async () => {
  const { element, props, update } = await createMultiSelect();

  await pressKey(element, "ArrowDown");
  await pressKey(element, "ArrowDown");
  update({ options: options.filter((option) => option.value !== gemini) });
  flush();
  await waitForSolid(() => {
    const highlighted = element.querySelector('.multi-select__option[aria-selected="true"]');
    expect(highlighted?.getAttribute("data-value")).toBe(opus);
  });
  await pressKey(element, "Enter");

  expect(props.onChange).toHaveBeenCalledExactlyOnceWith([sonnet, opus]);
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
