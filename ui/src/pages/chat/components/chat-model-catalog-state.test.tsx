/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatModelCatalogRefresh, ChatModelCatalogState } from "./chat-model-catalog-state.tsx";
import {
  modelControlSelector,
  modelOption,
  modelPickerProps,
  mountModelPicker,
  waitForModelMenu,
} from "./chat-model-picker.test-support.tsx";

it.each([
  ["loading", true, undefined, "refresh", "Refreshing models…"],
  ["ready", true, ["openai", "clawrouter"], "refresh", "Refreshing models for OpenAI, Clawrouter…"],
  ["loading", false, ["clawrouter"], "loading", "Loading models…"],
  ["ready", false, ["clawrouter"], "loading", "Loading models…"],
  ["error", true, ["clawrouter"], "settled", "Some models could not be refreshed."],
  ["offline", true, ["clawrouter"], "settled", "Offline"],
  ["ready", false, undefined, "setup", "No models available"],
] as const)(
  "presents %s with options=%s and pending=%j",
  (status, hasOptions, pendingProviders, presentation, label) => {
    const state: ModelCatalogState = {
      hasSnapshot: presentation !== "loading",
      status,
      pendingProviders: pendingProviders ? [...pendingProviders] : undefined,
    };
    const container = document.createElement("div");
    const setup = vi.fn();
    const render = (Component = ChatModelCatalogState) => {
      const view = mountSolid(
        () => (
          <Component
            {...{ state, hasOptions }}
            hasSelectableOptions={hasOptions}
            onModelSetup={presentation === "setup" ? setup : undefined}
          />
        ),
        { container },
      );
      flush();
      return view;
    };
    const mounted = render();
    if (presentation === "refresh") {
      expect(container.querySelector("[role=status]")).toBeNull();
      mounted.unmount();
      render(ChatModelCatalogRefresh);
      expect(container.querySelector(".btn__spinner")?.getAttribute("aria-hidden")).toBe("true");
      expect(
        container.querySelector(".chat-controls__model-refresh-details")?.textContent,
      ).toContain(label);
      expect(container.querySelector(".sr-only")).toBeNull();
    } else {
      expect(container.querySelector(".btn__spinner") !== null).toBe(presentation === "loading");
    }
    expect(container.querySelector("[role=status]")?.textContent).toContain(label);
    if (presentation === "loading") {
      expect(container.textContent).not.toContain("No models available");
    } else if (presentation === "setup") {
      container.querySelector<HTMLButtonElement>(modelControlSelector("setup"))?.click();
      expect(setup).toHaveBeenCalledOnce();
    } else if (presentation === "settled") {
      mounted.unmount();
      render(ChatModelCatalogRefresh);
      expect(container.querySelector<HTMLElement>(modelControlSelector("refresh"))).toBeNull();
    }
  },
);

it.each([
  "restore search",
  "restore trigger",
  "preserve moved focus",
  "keep closed",
  "keep removed",
] as const)("handles focused refresh settlement: %s", async (afterCommit) => {
  const container = document.createElement("div");
  const elsewhere = document.createElement("button");
  document.body.append(container, elsewhere);
  onTestFinished(() => {
    container.remove();
    elsewhere.remove();
  });
  const params = modelPickerProps({
    modelOptions: [modelOption("example", "model", { label: "Example Model" })],
    selectedModelValue: "example/model",
    triggerModelLabel: "Example Model",
    open: true,
  });
  const pending: ModelCatalogState = {
    hasSnapshot: true,
    status: "ready",
    pendingProviders: ["example"],
  };
  const view = mountModelPicker({ ...params, modelCatalogState: pending }, { container });
  const update = (state: ModelCatalogState, hasOptions = true) =>
    view.update({
      ...params,
      modelCatalogState: state,
      modelOptions: hasOptions ? params.modelOptions : [],
    });
  await waitForModelMenu(container);
  const pickerDetails = container.querySelector("details")!;
  const input = container.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
  const refresh = container.querySelector<HTMLButtonElement>("[data-chat-model-refresh] button")!;
  input.value = "model";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  refresh.focus();
  update(pending);
  await Promise.resolve();
  expect(document.activeElement).toBe(refresh);

  update({ hasSnapshot: true, status: "ready" }, afterCommit !== "restore trigger");
  if (afterCommit === "preserve moved focus") {
    elsewhere.focus();
  } else if (afterCommit === "keep closed") {
    pickerDetails.open = false;
  } else if (afterCommit === "keep removed") {
    container.remove();
  }
  await Promise.resolve();

  expect(container.querySelector<HTMLElement>(modelControlSelector("refresh"))).toBeNull();
  const expectedFocus = {
    "restore search": input,
    "restore trigger": container.querySelector("summary"),
    "preserve moved focus": elsewhere,
    "keep closed": document.body,
    "keep removed": document.body,
  };
  expect(document.activeElement).toBe(expectedFocus[afterCommit]);
  if (afterCommit === "restore search") {
    expect(input.value).toBe("model");
  }
});

// Missing-auth may mean disabled plugin or missing pin, not just signed out.
it.each([
  ["anthropic", "claude-cli", "Claude Code isn't ready. If signed out, run claude auth login."],
  ["openai", undefined, "No models available"],
] as const)(
  "explains an empty picker of missing-auth %s rows (runtime %s)",
  async (provider, agentRuntimeId, label) => {
    const { container } = mountModelPicker({
      modelCatalogState: { hasSnapshot: true, status: "ready" },
      modelOptions: [
        modelOption(provider, "model", {
          agentRuntimeId,
          disabled: true,
          unavailableReason: "missing-auth",
          isDefault: true,
          label: "Model",
        }),
      ],
      open: true,
      selectedModelValue: `${provider}/model`,
      sessionModelPinned: false,
      triggerModelLabel: "Model",
      onModelSetup: () => {},
    });
    await waitForModelMenu(container);
    expect(
      container.querySelector(".chat-controls__model-catalog-state-label")?.textContent?.trim(),
    ).toBe(label);
    expect(container.querySelector<HTMLElement>(modelControlSelector("setup"))).not.toBeNull();
  },
);
