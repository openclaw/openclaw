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

function control(root: ParentNode, name: string, value?: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(modelControlSelector(name, value));
}

function searchFor(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

function keydown(input: HTMLInputElement, key: string) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flush();
}

function accountSection(onSelect = vi.fn(), open = false) {
  return {
    onClose() {},
    viewProps: (startIndex: number) => ({
      selectionKind: "automatic" as const,
      disabled: false,
      selectedIdentity: "Current account",
      options: [{ value: "current", label: "Needle account" }],
      currentValue: "current",
      open,
      error: null,
      startIndex,
      onToggle() {},
      onSelect,
    }),
  };
}

it("forgets disclosure for removed providers", async () => {
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
  const toggle = () => control(group(), "provider-toggle")!;
  const rest = () => control(group(), "option", "other/rest")!;
  toggle().click();
  flush();
  control(group(), "more-toggle")!.click();
  flush();
  expect(rest().hidden).toBe(false);

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
  expect(control(group(), "more-toggle")!.hidden).toBe(false);
});

it.each([
  {
    hasDefault: false,
    inherited: false,
    leading: ["fixture/model-299", "fixture/model-0", "fixture/model-1"],
    selectedIndex: 0,
  },
  {
    hasDefault: true,
    inherited: false,
    leading: ["fixture/model-0", "fixture/model-299", "fixture/model-1"],
    selectedIndex: 1,
  },
  {
    hasDefault: true,
    inherited: true,
    leading: ["fixture/model-0", "fixture/model-1", "fixture/model-2"],
    selectedIndex: 0,
  },
])(
  "keeps the selection in a bounded catalog (default=$hasDefault, inherited=$inherited)",
  async ({ hasDefault, inherited, leading, selectedIndex }) => {
    const { container } = mountPicker({
      open: true,
      modelOptions: Array.from({ length: 300 }, (_, index) =>
        option("fixture", `model-${index}`, {
          commitValue: hasDefault && index === 0 ? "" : `fixture/model-${index}`,
          label: `Model ${index}`,
          isDefault: hasDefault && index === 0,
        }),
      ),
      selectedModelValue: inherited ? "" : "fixture/model-299",
      sessionModelPinned: !inherited,
      triggerModelLabel: "Model 299",
    });
    await waitForMenu(container);
    const visibleRows = () =>
      Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-option]"));
    const rows = visibleRows();
    expect(rows).toHaveLength(9);
    expect(rows.slice(0, 3).map((row) => row.dataset.chatModelOption)).toEqual(leading);
    expect(rows[selectedIndex]?.getAttribute("aria-selected")).toBe("true");
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
    const more = control(container, "more-toggle")!;
    const rest = () => control(container, "option", "fixture/rest");
    const group = control(container, "provider-toggle")!;
    expect(more.hidden).toBe(false);
    expect(rest()).toBeNull();

    more.focus();
    more.click();
    flush();
    expect(more.isConnected).toBe(false);
    expect(rest()?.hidden).toBe(false);
    // Keyboard focus lands on the first selectable revealed model, else back on search.
    expect(document.activeElement).toBe(restDisabled ? control(container, "search") : rest());

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
  const provider = (value: string) =>
    control(container, "option", value)?.closest("section")?.dataset.chatModelProviderGroup;
  expect([
    provider("anthropic/claude-opus-4-8"),
    provider("claude-cli/claude-haiku-5-5"),
    provider("anthropic/claude-sonnet-5-5"),
  ]).toEqual(["claude-cli", "claude-cli", "anthropic"]);
  // Claude CLI signs in through the Anthropic account, so its group carries that auth label.
  expect(
    container.querySelector(
      '[data-chat-model-provider-group="claude-cli"] .chat-controls__auth-meta-label',
    )?.textContent,
  ).toBe("Claude Max");
});

it("keeps search live while targets load, then ranks model, target, and account choices", async () => {
  const selectTarget = vi.fn();
  const selectAccount = vi.fn();
  const completion = Promise.withResolvers<readonly { value: string; label: string }[]>();
  const options = [{ value: "remote", label: "Needle target" }];
  const group = {
    id: "target",
    label: "CLI agents",
    errorLabel: "Unavailable",
    options: [],
    completion: { promise: completion.promise },
  };
  const params = pickerProps({
    open: true,
    modelOptions: [
      option("needle", "provider", { label: "Provider match" }),
      option("fixture", "disabled", { label: "Needle disabled", disabled: true }),
      option("fixture", "model", { label: "Needle model" }),
    ],
    selectedModelValue: "needle/provider",
    targetGroups: [group],
    onTargetSelect: selectTarget,
    accountSection: accountSection(selectAccount),
  });
  const { container, update } = mountPicker(params);
  await waitForMenu(container);
  const search = container.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
  expect(
    container.querySelector(
      '[data-chat-model-target-group] [data-chat-model-catalog-state="loading"]',
    ),
  ).not.toBeNull();
  search.focus();
  searchFor(search, "needle");
  const model = control(container, "option", "fixture/model")!;
  expect(model.hidden).toBe(false);
  expect(search.getAttribute("aria-activedescendant")).toBe(model.id);
  expect(control(container, "option", "account:current")?.dataset.chatModelRank).toBe("2");
  const loadedParams = { ...params, targetGroups: [{ ...group, options }] };
  update(loadedParams);
  completion.resolve(options);
  await waitForSolid(() => expect(control(container, "target", "remote")).not.toBeNull());
  expect(control(container, "search")).toBe(search);
  expect(control(container, "option", "fixture/model")).toBe(model);
  expect(document.activeElement).toBe(search);
  expect(
    container.querySelector("[data-chat-model-target-group] [data-chat-model-catalog-state]"),
  ).toBeNull();
  expect(control(container, "option", "account:current")?.dataset.chatModelRank).toBe("3");
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
  keydown(search, "ArrowDown");
  const target = ranked()[2]!;
  expect(search.getAttribute("aria-activedescendant")).toBe(target.id);
  update({
    ...loadedParams,
    modelOptions: [option("fixture", "new", { label: "Needle new" }), ...params.modelOptions],
  });
  expect(control(container, "highlighted")).toBe(target);
  keydown(search, "Enter");
  expect(selectTarget).toHaveBeenCalledWith("target", "remote");
  expect(selectAccount).not.toHaveBeenCalled();
});
