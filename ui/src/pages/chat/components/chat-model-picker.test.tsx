/* @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { findMenuShortcut } from "../../../components/menu-shortcuts.ts";
import type { ModelProviderAuthLabel } from "../../../lib/model-provider-auth-label.ts";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  modelControlSelector,
  modelOption as option,
  modelPickerProps as pickerProps,
  mountModelPicker as mountPicker,
  waitForModelMenu as waitForMenu,
} from "./chat-model-picker.test-support.tsx";

// Cold code loading is covered in Chromium; these cases exercise the loaded panel.
beforeAll(async () => {
  await import("./chat-model-picker-panel.tsx");
});

beforeEach(installModelPickerLayout);
afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "initially expands the selected provider and retains toggles on reopen (inherited=%s)",
  async (inherited) => {
    const params = pickerProps({
      modelOptions: [
        option("other", "first", { label: "Other" }),
        option("selected", "current", {
          commitValue: inherited ? "" : "selected/current",
          label: "Current",
          isDefault: inherited,
        }),
      ],
      selectedModelValue: inherited ? "" : "selected/current",
      sessionModelPinned: !inherited,
      open: true,
    });
    const { container, update } = mountPicker(params);
    await waitForMenu(container);
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    const selected = container.querySelector<HTMLButtonElement>(
      modelControlSelector("option", "selected/current"),
    )!;
    const other = () =>
      container.querySelector<HTMLButtonElement>(modelControlSelector("option", "other/first"));
    const toggle = selected
      .closest("section")!
      .querySelector<HTMLButtonElement>("[data-chat-model-provider-toggle]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(selected.hidden).toBe(false);
    expect(other()).toBeNull();

    toggle.click();
    flush();
    expect(selected.isConnected).toBe(false);
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await waitForMenu(container);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(selected.isConnected).toBe(false);
    expect(other()).toBeNull();

    // The next selection, including a change while closed, owns the open group.
    update({ ...params, open: false, selectedModelValue: "other/first" });
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await waitForMenu(container);
    expect(other()?.hidden).toBe(false);
    expect(selected.isConnected).toBe(false);
  },
);

it("retains disclosure across catalog refreshes and forgets removed providers", async () => {
  const params = pickerProps({
    open: true,
    modelOptions: [
      option("selected", "current"),
      option("other", "lead", { recommended: true }),
      option("other", "rest"),
    ],
    selectedModelValue: "selected/current",
  });
  const { container, update } = mountPicker(params);
  await waitForMenu(container);
  const group = () =>
    container.querySelector<HTMLElement>('[data-chat-model-provider-group="other"]')!;
  const toggle = () =>
    group().querySelector<HTMLButtonElement>(modelControlSelector("provider-toggle"))!;
  const rest = () =>
    group().querySelector<HTMLButtonElement>(modelControlSelector("option", "other/rest"))!;
  toggle().click();
  flush();
  group().querySelector<HTMLButtonElement>(modelControlSelector("more-toggle"))!.click();
  flush();
  const initialRest = rest();
  expect(initialRest.hidden).toBe(false);

  update({ ...params, modelOptions: params.modelOptions.map((entry) => ({ ...entry })) });
  expect(rest()).toBe(initialRest);
  expect(rest().hidden).toBe(false);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");

  update({
    ...params,
    modelOptions: params.modelOptions.filter((entry) => entry.provider !== "other"),
  });
  expect(group()).toBeNull();
  update(params);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  toggle().click();
  flush();
  expect(rest()).toBeNull();
  expect(
    group().querySelector<HTMLButtonElement>(modelControlSelector("more-toggle"))!.hidden,
  ).toBe(false);
});

it.each([false, true])(
  "keeps current visible in a bounded catalog with Default=%s",
  async (hasDefault) => {
    const { container } = mountPicker({
      open: true,
      modelOptions: Array.from({ length: 300 }, (_, index) =>
        option("fixture", `model-${index}`, {
          commitValue: hasDefault && index === 0 ? "" : `fixture/model-${index}`,
          label: `Model ${index}`,
          isDefault: hasDefault && index === 0,
        }),
      ),
      selectedModelValue: "fixture/model-299",
      triggerModelLabel: "Model 299",
    });
    await waitForMenu(container);
    const visibleRows = () =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-option]"));
    const rows = visibleRows();
    expect(rows).toHaveLength(9);
    expect(rows.slice(0, 3).map((row) => row.dataset.chatModelOption)).toEqual(
      hasDefault
        ? ["fixture/model-0", "fixture/model-299", "fixture/model-1"]
        : ["fixture/model-299", "fixture/model-0", "fixture/model-1"],
    );
    expect(rows[hasDefault ? 1 : 0]?.getAttribute("aria-selected")).toBe("true");
    const more = () =>
      container.querySelector<HTMLButtonElement>(modelControlSelector("more-toggle"));
    const search = container.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
    search.value = "Model 298";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(visibleRows().map((row) => row.dataset.chatModelOption)).toEqual(["fixture/model-298"]);
    expect(more()).toBeNull();
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(visibleRows()).toHaveLength(9);
    more()!.click();
    flush();
    expect(visibleRows().length).toBeLessThan(40);
    expect(visibleRows()[0]?.getAttribute("aria-setsize")).toBe("9");
    expect(visibleRows().some((row) => row.getAttribute("aria-setsize") === "291")).toBe(true);
    expect(more()).toBeNull();
  },
);

it.each([false, true])(
  "drops the All models row once expanded so the rest continue the group (rest disabled=%s)",
  async (restDisabled) => {
    const { container } = mountPicker({
      modelOptions: [
        option("fixture", "lead", { recommended: true }),
        option("fixture", "rest", { disabled: restDisabled }),
      ],
      selectedModelValue: "fixture/lead",
      triggerModelLabel: "lead",
      open: true,
    });
    await waitForMenu(container);
    const more = container.querySelector<HTMLButtonElement>(modelControlSelector("more-toggle"))!;
    const details = container.querySelector("details")!;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await waitForMenu(container);
    const rest = () =>
      container.querySelector<HTMLButtonElement>(modelControlSelector("option", "fixture/rest"));
    const group = container.querySelector<HTMLButtonElement>(
      modelControlSelector("provider-toggle"),
    )!;
    expect(more.hidden).toBe(false);
    expect(rest()).toBeNull();

    more.focus();
    more.click();
    flush();
    expect(more.isConnected).toBe(false);
    expect(rest()?.hidden).toBe(false);
    // Keyboard focus lands on the first selectable revealed model, else back on search.
    expect(document.activeElement).toBe(
      restDisabled ? container.querySelector<HTMLElement>(modelControlSelector("search")) : rest(),
    );

    group.click();
    flush();
    group.click();
    flush();
    expect(more.isConnected).toBe(false);
    expect(rest()?.hidden).toBe(false);
  },
);

it("groups Anthropic refs pinned to Claude CLI under Claude CLI", async () => {
  const { container } = mountPicker({
    open: true,
    modelOptions: [
      option("anthropic", "claude-opus-4-8", { agentRuntimeId: "claude-cli" }),
      option("claude-cli", "claude-haiku-5-5"),
      option("anthropic", "claude-sonnet-5-5", { agentRuntimeId: "openclaw" }),
    ],
    selectedModelValue: "anthropic/claude-opus-4-8",
    triggerModelLabel: "claude-opus-4-8",
    providerAuth: new Map<string, ModelProviderAuthLabel>([
      ["anthropic", { kind: "subscription", label: "Claude Max" }],
    ]),
  });
  await waitForMenu(container);
  container
    .querySelector<HTMLButtonElement>(
      '[data-chat-model-provider-group="anthropic"] [data-chat-model-provider-toggle]',
    )!
    .click();
  flush();
  const groups = Object.fromEntries(
    Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]")).map(
      (group) => [
        group.dataset.chatModelProviderGroup,
        Array.from(group.querySelectorAll<HTMLElement>("[data-chat-model-option]")).map(
          (row) => row.dataset.chatModelOption,
        ),
      ],
    ),
  );
  expect(groups).toEqual({
    "claude-cli": ["anthropic/claude-opus-4-8", "claude-cli/claude-haiku-5-5"],
    anthropic: ["anthropic/claude-sonnet-5-5"],
  });
  // Claude CLI signs in through the Anthropic account, so its group carries that auth label.
  expect(
    container.querySelector(
      '[data-chat-model-provider-group="claude-cli"] .chat-controls__auth-meta-label',
    )?.textContent,
  ).toBe("Claude Max");
});

it("derives rank and keyboard choices across model, target, and account rows", async () => {
  const selectTarget = vi.fn();
  const selectAccount = vi.fn();
  const params = pickerProps({
    open: true,
    modelOptions: [
      option("needle", "provider", { label: "Provider match" }),
      option("fixture", "disabled", { label: "Needle disabled", disabled: true }),
      option("fixture", "model", { label: "Needle model" }),
    ],
    selectedModelValue: "needle/provider",
    targetGroups: [
      {
        id: "target",
        label: "Target",
        completion: { promise: Promise.resolve([{ value: "remote", label: "Needle target" }]) },
        errorLabel: "",
        options: [{ value: "remote", label: "Needle target" }],
      },
    ],
    onTargetSelect: selectTarget,
    accountSection: {
      onClose() {},
      viewProps: (startIndex) => ({
        selectionKind: "automatic",
        disabled: false,
        selectedIdentity: "Current account",
        options: [{ value: "current", label: "Needle account" }],
        currentValue: "current",
        open: false,
        error: null,
        startIndex,
        onToggle() {},
        onSelect: selectAccount,
      }),
    },
  });
  const { container, update } = mountPicker(params);
  await waitForMenu(container);
  await waitForSolid(() =>
    expect(container.querySelector(modelControlSelector("target", "remote"))).not.toBeNull(),
  );
  const search = container.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
  search.value = "needle";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  const ranked = () =>
    [
      ...container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]:not([hidden])"),
    ].toSorted((a, b) => Number(a.dataset.chatModelRank) - Number(b.dataset.chatModelRank));
  expect(ranked().map((row) => row.dataset.chatModelOption)).toEqual([
    "fixture/disabled",
    "fixture/model",
    "target:target:remote",
    "account:current",
    "needle/provider",
  ]);
  const model = ranked()[1]!;
  const details = container.querySelector<HTMLDetailsElement>("details")!;
  expect(findMenuShortcut(details, "1")).toBe(model);
  expect(findMenuShortcut(details, "2")).toBe(ranked()[2]);
  // Account and selected rows consume positions without advertising a global shortcut.
  expect(findMenuShortcut(details, "3")).toBeUndefined();
  expect(findMenuShortcut(details, "4")).toBeUndefined();
  expect(model.hasAttribute("data-chat-model-highlighted")).toBe(true);
  expect(search.getAttribute("aria-activedescendant")).toBe(model.id);
  expect(
    model
      .querySelector("[data-chat-model-shortcut]")
      ?.getAttribute("data-chat-model-shortcut-number"),
  ).toBe("1");
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  flush();
  const target = ranked()[2]!;
  expect(search.getAttribute("aria-activedescendant")).toBe(target.id);
  update({
    ...params,
    modelOptions: [option("fixture", "new", { label: "Needle new" }), ...params.modelOptions],
  });
  expect(container.querySelector(modelControlSelector("highlighted"))).toBe(target);
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(selectTarget).toHaveBeenCalledWith("target", "remote");
  expect(selectAccount).not.toHaveBeenCalled();
});

it("keeps model search and account indexing live while CLI targets load", async () => {
  const completion = Promise.withResolvers<readonly { value: string; label: string }[]>();
  const accountProps = vi.fn((startIndex: number) => ({
    selectionKind: "automatic" as const,
    disabled: false,
    selectedIdentity: "Current account",
    options: [{ value: "current", label: "Needle account" }],
    currentValue: "current",
    open: true,
    error: null,
    startIndex,
    onToggle() {},
    onSelect: vi.fn(),
  }));
  const group = {
    id: "target",
    label: "CLI agents",
    errorLabel: "CLI agents unavailable",
    options: [],
    completion: { promise: completion.promise },
  };
  const params = pickerProps({
    open: true,
    modelOptions: [option("fixture", "current", { label: "Needle model" })],
    targetGroups: [group],
    accountSection: { onClose() {}, viewProps: accountProps },
  });
  const { container, update } = mountPicker(params);
  await waitForMenu(container);
  const search = container.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
  const model = container.querySelector<HTMLButtonElement>(
    modelControlSelector("option", "fixture/current"),
  )!;
  expect(
    container.querySelector(
      '[data-chat-model-target-group] [data-chat-model-catalog-state="loading"]',
    ),
  ).not.toBeNull();
  expect(accountProps).toHaveBeenLastCalledWith(1);
  search.focus();
  search.value = "needle";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(model.hidden).toBe(false);
  expect(search.getAttribute("aria-activedescendant")).toBe(model.id);
  expect(container.querySelector(modelControlSelector("option", "account:current"))).not.toBeNull();

  const options = [{ value: "remote", label: "Needle target" }];
  update({ ...params, targetGroups: [{ ...group, options }] });
  completion.resolve(options);
  await waitForSolid(() =>
    expect(container.querySelector(modelControlSelector("target", "remote"))).not.toBeNull(),
  );
  expect(container.querySelector(modelControlSelector("search"))).toBe(search);
  expect(container.querySelector(modelControlSelector("option", "fixture/current"))).toBe(model);
  expect(document.activeElement).toBe(search);
  expect(accountProps).toHaveBeenLastCalledWith(2);
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  flush();
  const target = container.querySelector<HTMLButtonElement>(
    modelControlSelector("target", "remote"),
  )!;
  expect(search.getAttribute("aria-activedescendant")).toBe(target.id);

  target.focus();
  update({
    ...params,
    modelOptions: params.modelOptions.map((entry) =>
      Object.assign({}, entry, { label: "Needle renamed" }),
    ),
    targetGroups: [{ ...group, options }],
  });
  await waitForSolid(() => expect(model.textContent).toContain("Needle renamed"));
  expect(container.querySelector(modelControlSelector("target", "remote"))).toBe(target);
  expect(document.activeElement).toBe(target);
  expect(
    container.querySelector("[data-chat-model-target-group] [data-chat-model-catalog-state]"),
  ).toBeNull();
  expect(search.value).toBe("needle");
});

it("restores the selected keyboard choice when an unfiltered picker reopens", async () => {
  const onModelSelect = vi.fn();
  const { container } = mountPicker({
    open: true,
    modelOptions: [option("fixture", "current"), option("fixture", "other")],
    onModelSelect,
  });
  await waitForMenu(container);
  const details = container.querySelector<HTMLDetailsElement>("details")!;
  const search = container.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
  details.open = false;
  details.dispatchEvent(new Event("toggle"));
  flush();
  details.open = true;
  details.dispatchEvent(new Event("toggle"));
  flush();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onModelSelect).toHaveBeenCalledWith("fixture/current", "main", undefined);
});
