/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  renderChatModelCatalogRefresh,
  renderChatModelCatalogState,
  type ChatModelCatalogState,
} from "./chat-model-catalog-state.ts";
import { renderChatModelPicker } from "./chat-model-picker.ts";

describe("model catalog refresh presentation", () => {
  it.each([
    { status: "loading", label: "Refreshing models…" },
    {
      status: "ready",
      pendingProviders: ["openai", "clawrouter"],
      label: "Refreshing models for OpenAI, Clawrouter…",
    },
  ] as const)("keeps a $status background refresh out of the model list", ({ label, ...state }) => {
    const catalog = { hasSnapshot: true, ...state };
    const container = document.createElement("div");
    render(renderChatModelCatalogState(catalog, true, true), container);
    expect(container.querySelector("[role=status]")).toBeNull();

    render(renderChatModelCatalogRefresh(catalog), container);
    expect(container.querySelector("[role=status]")?.textContent).toContain(label);
    expect(container.querySelector(".btn__spinner")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".sr-only")?.textContent).toBe(label);
  });

  it.each(["idle", "ready", "error", "offline"] as const)(
    "does not show a refresh spinner for a settled %s catalog",
    (status) => {
      const container = document.createElement("div");
      render(renderChatModelCatalogRefresh({ hasSnapshot: true, status }), container);
      expect(container.querySelector("[data-chat-model-refresh]")).toBeNull();
    },
  );

  it.each(["loading", "ready"] as const)(
    "shows initial loading instead of an empty %s catalog",
    (status) => {
      const container = document.createElement("div");
      render(
        renderChatModelCatalogState(
          { hasSnapshot: false, status, pendingProviders: ["clawrouter"] },
          false,
          false,
        ),
        container,
      );
      expect(container.textContent).toContain("Loading models…");
      expect(container.querySelector(".btn__spinner")).not.toBeNull();
      expect(container.textContent).not.toContain("No models available");
    },
  );

  it.each([
    { status: "error", label: "Some models could not be refreshed." },
    { status: "offline", label: "Offline" },
  ] as const)(
    "keeps $status visible even with retained models and pending providers",
    ({ status, label }) => {
      const container = document.createElement("div");
      const state: ChatModelCatalogState = {
        hasSnapshot: true,
        status,
        pendingProviders: ["clawrouter"],
      };
      render(renderChatModelCatalogRefresh(state), container);
      expect(container.querySelector("[data-chat-model-refresh]")).toBeNull();
      render(renderChatModelCatalogState(state, true, true), container);
      expect(container.querySelector("[role=status]")?.textContent).toContain(label);
      expect(container.querySelector(".btn__spinner")).toBeNull();
    },
  );

  it.each([
    { status: "ready", afterCommit: "restore search" },
    { status: "error", afterCommit: "restore search" },
    { status: "offline", afterCommit: "restore search" },
    { status: "ready", afterCommit: "restore trigger" },
    { status: "ready", afterCommit: "preserve moved focus" },
    { status: "ready", afterCommit: "keep closed" },
    { status: "ready", afterCommit: "keep removed" },
  ] as const)(
    "handles focused refresh settlement to $status: $afterCommit",
    async ({ status, afterCommit }) => {
      const container = document.createElement("div");
      const elsewhere = document.createElement("button");
      document.body.append(container, elsewhere);
      onTestFinished(() => {
        render(null, container);
        container.remove();
        elsewhere.remove();
      });
      const update = (modelCatalogState: ChatModelCatalogState, hasOptions = true) =>
        render(
          renderChatModelPicker({
            disabled: false,
            modelSelectionLocked: false,
            modelCatalogState,
            modelOptions: hasOptions
              ? [
                  {
                    commitValue: "example/model",
                    isDefault: false,
                    label: "Example Model",
                    provider: "example",
                    value: "example/model",
                  },
                ]
              : [],
            open: true,
            selectedModelValue: "example/model",
            sessionModelPinned: true,
            sessionKey: "main",
            triggerModelLabel: "Example Model",
            onModelSelect: async () => {},
          }),
          container,
        );
      const pending: ChatModelCatalogState = {
        hasSnapshot: true,
        status: "ready",
        pendingProviders: ["example"],
      };
      update(pending);
      await Promise.resolve();
      const input = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
      const refresh = container.querySelector<HTMLButtonElement>(
        "[data-chat-model-refresh] button",
      );
      if (!input || !refresh) {
        throw new Error("Expected the model search and refresh control");
      }
      input.value = "model";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      refresh.focus();
      update(pending);
      await Promise.resolve();
      expect(document.activeElement).toBe(refresh);

      update({ hasSnapshot: true, status }, afterCommit !== "restore trigger");
      if (afterCommit === "preserve moved focus") {
        elsewhere.focus();
      } else if (afterCommit === "keep closed") {
        const details = container.querySelector("details");
        if (!details) {
          throw new Error("Expected the model picker");
        }
        details.open = false;
      } else if (afterCommit === "keep removed") {
        container.remove();
      }
      await Promise.resolve();

      expect(container.querySelector("[data-chat-model-refresh]")).toBeNull();
      expect(document.activeElement).toBe(
        afterCommit === "restore search"
          ? input
          : afterCommit === "restore trigger"
            ? container.querySelector("summary")
            : afterCommit === "preserve moved focus"
              ? elsewhere
              : document.body,
      );
      if (afterCommit === "restore search") {
        expect(input.value).toBe("model");
      }
    },
  );

  it("preserves the empty-catalog setup action", () => {
    const container = document.createElement("div");
    const setup = vi.fn();
    render(
      renderChatModelCatalogState({ hasSnapshot: true, status: "ready" }, false, false, setup),
      container,
    );
    expect(container.textContent).toContain("No models available");
    container.querySelector<HTMLButtonElement>("[data-chat-model-setup]")?.click();
    expect(setup).toHaveBeenCalledOnce();
  });
});
