/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { installModelPickerLayout } from "../../test-helpers/model-picker-layout.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createChatHeaderState, renderModelControls } from "./chat-model-controls.test-support.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";

beforeEach(() => {
  installModelPickerLayout();
  onTestFinished(installChatComposerPickerDismissal(document));
});

describe("chat model controls", () => {
  it("groups models and preserves ranked keyboard selection through catalog replacement", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
        { id: "gemini-2.5-pro", name: "Anth model", provider: "google" },
        {
          id: "unavailable",
          name: "Anth unavailable",
          provider: "google",
          available: false,
          unavailableReason: "cooldown",
        },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const onProviderSettings = vi.fn();
    const callbacks = { onModelSelect, onProviderSettings };
    const container = await renderModelControls(state, callbacks);
    document.body.append(container);

    const providerHeadings = Array.from(
      container.querySelectorAll<HTMLElement>("[data-chat-model-provider]"),
    );
    expect(
      providerHeadings.map((heading) =>
        heading.querySelector(".chat-controls__provider-label")?.textContent?.trim(),
      ),
    ).toEqual(["OpenAI", "Anthropic", "Google"]);
    const providerSettings = providerHeadings[0]?.querySelector<HTMLButtonElement>(
      "[data-chat-model-provider-settings]",
    );
    expect(providerSettings?.getAttribute("aria-label")).toBe("Configure models");
    expect(providerSettings?.closest("openclaw-tooltip")).toBeNull();
    expect(providerSettings?.closest('[role="listbox"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).every(
        (option) => option.closest('[role="listbox"]') !== null,
      ),
    ).toBe(true);
    providerSettings?.click();
    expect(onProviderSettings).toHaveBeenCalledExactlyOnceWith("openai");
    const anthropicModels = container.querySelector<HTMLElement>(
      '[data-chat-model-provider-group="anthropic"]',
    );
    const anthropicToggle = anthropicModels!.querySelector<HTMLButtonElement>(
      "[data-chat-model-provider-toggle]",
    )!;
    expect(anthropicToggle.getAttribute("aria-expanded")).toBe("false");
    anthropicToggle.click();
    flush();
    expect(anthropicModels?.textContent).toContain("Claude Sonnet 4.6");
    anthropicToggle.click();
    flush();
    const details = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
    details!.open = true;
    expect(container.querySelector("[data-chat-model-selection-target]")).toBeNull();
    search!.value = "anth";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();

    const visibleOptions = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).filter((option) => !option.hidden);
    expect(visibleOptions.map((option) => option.dataset.chatModelOption)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "google/gemini-2.5-pro",
      "google/unavailable",
    ]);
    expect(visibleOptions[1]?.hasAttribute("data-chat-model-highlighted")).toBe(true);
    expect(visibleOptions[2]?.disabled).toBe(true);
    expect(
      visibleOptions[2]?.querySelector(
        "[data-chat-model-shortcut][data-chat-model-shortcut-number]",
      ),
    ).toBeNull();
    expect(
      visibleOptions[1]
        ?.querySelector("[data-chat-model-shortcut]")
        ?.getAttribute("data-chat-model-shortcut-number"),
    ).toBe("1");
    expect(
      visibleOptions[0]?.querySelector(".chat-controls__model-option-provider"),
    ).not.toBeNull();

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    flush();
    const highlighted = container.querySelector<HTMLButtonElement>("[data-chat-model-highlighted]");
    expect(highlighted).toBe(visibleOptions[0]);
    expect(highlighted?.id).not.toBe("");
    expect(search?.getAttribute("aria-activedescendant")).toBe(highlighted?.id);

    state.chatModelCatalog = [
      ...state.chatModelCatalog,
      { id: "new-match", name: "Anth new", provider: "openai" },
    ];
    await renderModelControls(state, { ...callbacks, modelPickerOpen: true }, container);
    await Promise.resolve();
    expect(container.querySelector("[data-chat-model-search]")).toBe(search);
    expect(search?.value).toBe("anth");
    expect(container.querySelector("[data-chat-model-highlighted]")).toBe(highlighted);
    expect(search?.getAttribute("aria-activedescendant")).toBe(highlighted?.id);

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onModelSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6", "main", undefined);
    expect(details?.open).toBe(false);

    onModelSelect.mockClear();
    details!.open = true;
    details!.dispatchEvent(new Event("toggle"));
    search!.value = "";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
    container
      .querySelector<HTMLButtonElement>(
        '[data-chat-model-provider-group="anthropic"] [data-chat-model-provider-toggle]',
      )!
      .click();
    flush();
    details!.dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    expect(onModelSelect).toHaveBeenCalledExactlyOnceWith(
      "anthropic/claude-sonnet-4-6",
      "main",
      undefined,
    );
    expect(details?.open).toBe(false);
    container.remove();
  });

  it("matches the default model by its localized marker and canonical reference", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "Chat Model", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
    });
    state.sessionsResult = createSessionsListResult({
      model: "gpt-5.5",
      modelProvider: "openai",
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
    });
    const container = await renderModelControls(state);
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");

    for (const query of ["default", "gpt-5.5", "OPENAI/GPT-5.5"]) {
      search!.value = query;
      search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
      flush();

      const visibleOptions = container.querySelectorAll("[data-chat-model-option]:not([hidden])");
      expect(visibleOptions, query).toHaveLength(1);
      expect(visibleOptions[0]?.getAttribute("data-chat-model-default")).toBe("true");
    }
  });

  it("leaves digit keys to nested controls and selects the numbered row from the picker", async () => {
    const { state } = createChatHeaderState({
      model: "gpt-5.5",
      modelProvider: "openai",
      models: [
        { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
      ],
    });
    const onModelSelect = vi.fn(async () => true);
    const container = await renderModelControls(state, {
      onModelSelect,
    });
    document.body.append(container);

    const details = container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker");
    const search = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
    details!.open = true;
    search!.value = "claude";
    search!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();

    search!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).not.toHaveBeenCalled();
    expect(search!.value).toBe("claude");

    const nestedPicker = document.createElement("div");
    nestedPicker.setAttribute("role", "menu");
    nestedPicker.setAttribute("popover", "manual");
    const nestedTrigger = document.createElement("button");
    nestedPicker.append(nestedTrigger);
    details!.append(nestedPicker);
    nestedTrigger.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).not.toHaveBeenCalled();

    details!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onModelSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6", "main", undefined);
    container.remove();
  });
});
