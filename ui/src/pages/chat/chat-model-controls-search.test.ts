/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { installModelPickerLayout } from "../../test-helpers/model-picker-layout.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createChatHeaderState, renderModelControls } from "./chat-model-controls.test-support.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";

beforeEach(() => {
  installModelPickerLayout();
  onTestFinished(installChatComposerPickerDismissal(document));
});

const openai = { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" };
const anthropic = { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" };
const headerState = (models: ModelCatalogEntry[] = [openai, anthropic]) =>
  createChatHeaderState({ model: openai.id, modelProvider: openai.provider, models }).state;
const keydown = (target: HTMLElement, key: string) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
function searchFor(search: HTMLInputElement, value: string) {
  search.value = value;
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
}
function pickerElements(container: HTMLElement) {
  return {
    details: container.querySelector<HTMLDetailsElement>(".chat-controls__model-picker")!,
    search: container.querySelector<HTMLInputElement>("[data-chat-model-search]")!,
  };
}

describe("chat model controls", () => {
  it("groups catalog models and selects a search result", async () => {
    const state = headerState([
      openai,
      anthropic,
      { id: "gemini-2.5-pro", name: "Anth model", provider: "google" },
      {
        id: "unavailable",
        name: "Anth unavailable",
        provider: "google",
        available: false,
        unavailableReason: "cooldown",
      },
    ]);
    const onModelSelect = vi.fn(async () => true);
    const onProviderSettings = vi.fn();
    const callbacks = { onModelSelect, onProviderSettings };
    const container = await renderModelControls(state, callbacks);
    document.body.append(container);
    const { details, search } = pickerElements(container);

    const providerSettings = container.querySelector<HTMLButtonElement>(
      "[data-chat-model-provider-settings]",
    )!;
    expect(providerSettings.closest('[role="listbox"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).every(
        (option) => option.closest('[role="listbox"]') !== null,
      ),
    ).toBe(true);
    providerSettings.click();
    expect(onProviderSettings).toHaveBeenCalledExactlyOnceWith("openai");
    details.open = true;
    expect(container.querySelector("[data-chat-model-selection-target]")).toBeNull();
    searchFor(search, "anth");

    const visibleOptions = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]"),
    ).filter((option) => !option.hidden);
    expect(visibleOptions.map((option) => option.dataset.chatModelOption)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "google/gemini-2.5-pro",
      "google/unavailable",
    ]);
    expect(visibleOptions[2]?.disabled).toBe(true);
    expect(
      visibleOptions[0]?.querySelector(".chat-controls__model-option-provider"),
    ).not.toBeNull();

    keydown(search, "1");
    expect(onModelSelect).not.toHaveBeenCalled();
    expect(search.value).toBe("anth");
    keydown(search, "ArrowDown");
    flush();
    keydown(search, "Enter");
    expect(onModelSelect).toHaveBeenCalledWith("anthropic/claude-sonnet-4-6", "main", undefined);
    expect(details?.open).toBe(false);
    container.remove();
  });

  it("matches the default model by its localized marker and canonical reference", async () => {
    const state = headerState([{ ...openai, name: "Chat Model" }, anthropic]);
    state.sessionsResult = createSessionsListResult({
      model: "gpt-5.5",
      modelProvider: "openai",
      defaultsModel: "gpt-5.5",
      defaultsProvider: "openai",
    });
    const container = await renderModelControls(state);
    const { search } = pickerElements(container);

    for (const query of ["default", "gpt-5.5", "OPENAI/GPT-5.5"]) {
      searchFor(search, query);

      const visibleOptions = container.querySelectorAll("[data-chat-model-option]:not([hidden])");
      expect(visibleOptions, query).toHaveLength(1);
      expect(visibleOptions[0]?.getAttribute("data-chat-model-default")).toBe("true");
    }
  });
});
