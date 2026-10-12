/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import type { ModelProviderAuthLabel } from "../../../lib/model-provider-auth-label.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { ChatModelPicker } from "./chat-model-picker.tsx";

it.each([false, true])(
  "initially expands the selected provider and retains toggles on reopen (inherited=%s)",
  async (inherited) => {
    const container = document.createElement("div");
    const params: Parameters<typeof ChatModelPicker>[0] = {
      disabled: false,
      modelSelectionLocked: false,
      modelOptions: [
        {
          provider: "other",
          value: "other/first",
          commitValue: "other/first",
          label: "Other",
          isDefault: false,
        },
        {
          provider: "selected",
          value: "selected/current",
          commitValue: inherited ? "" : "selected/current",
          label: "Current",
          isDefault: inherited,
        },
      ],
      selectedModelValue: inherited ? "" : "selected/current",
      sessionModelPinned: !inherited,
      sessionKey: "main",
      triggerModelLabel: "Current",
      open: true,
      onModelSelect: vi.fn(async () => {}),
    };
    render(solidTemplate(ChatModelPicker, params), container);
    await Promise.resolve();
    const details = container.querySelector<HTMLDetailsElement>("details")!;
    const selected = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="selected/current"]',
    )!;
    const other = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="other/first"]',
    )!;
    const toggle = selected
      .closest("section")!
      .querySelector<HTMLButtonElement>("[data-chat-model-provider-toggle]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(selected.hidden).toBe(false);
    expect(other.hidden).toBe(true);

    // A deliberate collapse survives closing and reopening the picker.
    toggle.click();
    expect(selected.hidden).toBe(true);
    details.open = false;
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(selected.hidden).toBe(true);
    expect(other.hidden).toBe(true);

    // The next selection, including a change while closed, owns the open group.
    render(
      solidTemplate(ChatModelPicker, { ...params, open: false, selectedModelValue: "other/first" }),
      container,
    );
    details.dispatchEvent(new Event("toggle"));
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    await Promise.resolve();
    expect(other.hidden).toBe(false);
    expect(selected.hidden).toBe(true);
  },
);

it.each([false, true])("keeps current visible with Default=%s", (hasDefault) => {
  const container = document.createElement("div");
  render(
    solidTemplate(ChatModelPicker, {
      disabled: false,
      modelSelectionLocked: false,
      modelOptions: Array.from({ length: 300 }, (_, index) => ({
        provider: "fixture",
        value: `fixture/model-${index}`,
        commitValue: hasDefault && index === 0 ? "" : `fixture/model-${index}`,
        label: `Model ${index}`,
        isDefault: hasDefault && index === 0,
      })),
      selectedModelValue: "fixture/model-299",
      sessionModelPinned: true,
      sessionKey: "main",
      triggerModelLabel: "Model 299",
      onModelSelect: vi.fn(async () => {}),
    }),
    container,
  );
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-model-option]"));
  expect(rows).toHaveLength(300);
  expect(rows.slice(0, 3).map((row) => row.dataset.chatModelOption)).toEqual(
    hasDefault
      ? ["fixture/model-0", "fixture/model-299", "fixture/model-1"]
      : ["fixture/model-299", "fixture/model-0", "fixture/model-1"],
  );
  expect(rows[hasDefault ? 1 : 0]?.getAttribute("aria-selected")).toBe("true");
});

it.each([false, true])(
  "drops the All models row once expanded so the rest continue the group (rest disabled=%s)",
  async (restDisabled) => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      solidTemplate(ChatModelPicker, {
        disabled: false,
        modelSelectionLocked: false,
        modelOptions: [
          {
            provider: "fixture",
            value: "fixture/lead",
            commitValue: "fixture/lead",
            label: "lead",
            isDefault: false,
            recommended: true,
          },
          {
            provider: "fixture",
            value: "fixture/rest",
            commitValue: "fixture/rest",
            label: "rest",
            isDefault: false,
            disabled: restDisabled,
          },
        ],
        selectedModelValue: "fixture/lead",
        sessionModelPinned: true,
        sessionKey: "main",
        triggerModelLabel: "lead",
        open: true,
        onModelSelect: vi.fn(async () => {}),
      }),
      container,
    );
    await Promise.resolve();
    const more = container.querySelector<HTMLButtonElement>("[data-chat-model-more-toggle]")!;
    const rest = container.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="fixture/rest"]',
    )!;
    const group = container.querySelector<HTMLButtonElement>("[data-chat-model-provider-toggle]")!;
    expect(more.hidden).toBe(false);
    expect(rest.hidden).toBe(true);

    more.focus();
    more.click();
    expect(more.hidden).toBe(true);
    expect(rest.hidden).toBe(false);
    // Keyboard focus lands on the first selectable revealed model, else back on search.
    expect(document.activeElement).toBe(
      restDisabled ? container.querySelector("[data-chat-model-search]") : rest,
    );

    // Collapsing and reopening the provider group keeps the models inline, with no row to re-collapse.
    group.click();
    group.click();
    expect(more.hidden).toBe(true);
    expect(rest.hidden).toBe(false);
    container.remove();
  },
);

it("groups Anthropic refs pinned to Claude CLI under Claude CLI", () => {
  const container = document.createElement("div");
  const option = (provider: string, id: string, agentRuntimeId?: string) => ({
    provider,
    value: `${provider}/${id}`,
    commitValue: `${provider}/${id}`,
    label: id,
    isDefault: false,
    ...(agentRuntimeId ? { agentRuntimeId } : {}),
  });
  render(
    solidTemplate(ChatModelPicker, {
      disabled: false,
      modelSelectionLocked: false,
      modelOptions: [
        option("anthropic", "claude-opus-4-8", "claude-cli"),
        option("claude-cli", "claude-haiku-5-5"),
        option("anthropic", "claude-sonnet-5-5", "openclaw"),
      ],
      selectedModelValue: "anthropic/claude-opus-4-8",
      sessionModelPinned: true,
      sessionKey: "main",
      triggerModelLabel: "claude-opus-4-8",
      onModelSelect: vi.fn(async () => {}),
      providerAuth: new Map<string, ModelProviderAuthLabel>([
        ["anthropic", { kind: "subscription", label: "Claude Max" }],
      ]),
    }),
    container,
  );
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
