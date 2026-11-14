/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatModelCatalogState } from "./chat-model-catalog-state.tsx";
import {
  modelControlSelector,
  modelOption,
  modelPickerProps,
  mountModelPicker,
  waitForModelMenu,
} from "./chat-model-picker.test-support.tsx";

it.each([
  ["idle", false, undefined, undefined],
  ["loading", true, undefined, undefined],
  ["ready", true, ["openai"], undefined],
  ["loading", false, ["openai"], undefined],
  ["ready", false, ["openai"], undefined],
  ["error", true, undefined, "Couldn’t refresh some models."],
  ["offline", true, undefined, "Disconnected"],
  ["ready", false, undefined, "No models available"],
] as const)("presents %s with options=%s and pending=%j", (status, hasOptions, pending, label) => {
  const state: ModelCatalogState = {
    hasSnapshot: status !== "idle" && status !== "loading",
    status,
    pendingProviders: pending ? [...pending] : undefined,
  };
  const setup = vi.fn();
  const { container } = mountSolid(() => (
    <ChatModelCatalogState
      state={state}
      hasOptions={hasOptions}
      hasSelectableOptions={hasOptions}
      onModelSetup={setup}
    />
  ));
  flush();
  expect(container.querySelector(".btn__spinner")).toBeNull();
  if (label) {
    expect(container.querySelector("[role=status]")?.textContent).toContain(label);
  } else {
    expect(container.querySelector("[role=status]")).toBeNull();
  }
  if (status === "ready" && !pending && !hasOptions) {
    container.querySelector<HTMLButtonElement>(modelControlSelector("setup"))?.click();
    expect(setup).toHaveBeenCalledOnce();
  }
});

// Missing-auth may mean disabled plugin or missing pin, not just signed out.
it.each([
  ["anthropic", "claude-cli", "Claude CLI isn’t ready. If signed out, run claude auth login."],
  ["openai", undefined, "Sign-in needed"],
] as const)(
  "explains a picker of missing-auth %s rows (runtime %s)",
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
      container.querySelector("[data-chat-model-auth-state] > span")?.textContent?.trim(),
    ).toBe(label);
    expect(container.querySelector<HTMLElement>(modelControlSelector("setup"))).not.toBeNull();
  },
);

it("keeps search available without a catalog loader, then shows results", async () => {
  installModelPickerLayout();
  const params = modelPickerProps({
    open: true,
    modelCatalogState: { hasSnapshot: false, status: "loading" },
  });
  const view = mountModelPicker(params);
  await waitForModelMenu(view.container);
  const search = view.container.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
  expect(search.disabled).toBe(false);
  expect(view.container.querySelector('[data-chat-model-catalog-state="loading"]')).toBeNull();
  view.update({
    ...params,
    modelOptions: [modelOption("example", "model")],
    modelCatalogState: { hasSnapshot: true, status: "ready" },
  });
  expect(view.container.querySelector("[data-chat-model-search]")).toBe(search);
  expect(view.container.querySelector('[data-chat-model-catalog-state="loading"]')).toBeNull();
  expect(view.container.querySelector('[data-chat-model-option="example/model"]')).not.toBeNull();
});
