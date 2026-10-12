/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatModelCatalogState as ModelCatalogState } from "../../../lib/model-catalog-store.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { ChatModelCatalogRefresh, ChatModelCatalogState } from "./chat-model-catalog-state.tsx";
import { ChatModelPicker } from "./chat-model-picker.tsx";

describe("model catalog refresh presentation", () => {
  it.each([
    ["loading", true, undefined, "refresh", "Refreshing models…"],
    [
      "ready",
      true,
      ["openai", "clawrouter"],
      "refresh",
      "Refreshing models for OpenAI, Clawrouter…",
    ],
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
      render(
        solidTemplate(ChatModelCatalogState, {
          state,
          hasOptions,
          hasSelectableOptions: hasOptions,
          onModelSetup: presentation === "setup" ? setup : undefined,
        }),
        container,
      );
      if (presentation === "refresh") {
        expect(container.querySelector("[role=status]")).toBeNull();
        render(solidTemplate(ChatModelCatalogRefresh, { state }), container);
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
        container.querySelector<HTMLButtonElement>("[data-chat-model-setup]")?.click();
        expect(setup).toHaveBeenCalledOnce();
      } else if (presentation === "settled") {
        render(solidTemplate(ChatModelCatalogRefresh, { state }), container);
        expect(container.querySelector("[data-chat-model-refresh]")).toBeNull();
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
      render(null, container);
      container.remove();
      elsewhere.remove();
    });
    const update = (modelCatalogState: ModelCatalogState, hasOptions = true) =>
      render(
        solidTemplate(ChatModelPicker, {
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
    const pending: ModelCatalogState = {
      hasSnapshot: true,
      status: "ready",
      pendingProviders: ["example"],
    };
    update(pending);
    await Promise.resolve();
    const input = container.querySelector<HTMLInputElement>("[data-chat-model-search]");
    const refresh = container.querySelector<HTMLButtonElement>("[data-chat-model-refresh] button");
    if (!input || !refresh) {
      throw new Error("Expected the model search and refresh control");
    }
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
  });

  // missing-auth on a Claude CLI row also means a disabled anthropic plugin or a missing
  // account pin, so the hint must stay true for a user who is already signed in.
  it.each([
    ["anthropic", "claude-cli", "Claude Code isn't ready. If signed out, run claude auth login."],
    ["openai", undefined, "No models available"],
  ] as const)(
    "explains an empty picker of missing-auth %s rows (runtime %s)",
    (provider, agentRuntimeId, label) => {
      const container = document.createElement("div");
      render(
        solidTemplate(ChatModelPicker, {
          disabled: false,
          modelSelectionLocked: false,
          modelCatalogState: { hasSnapshot: true, status: "ready" },
          modelOptions: [
            {
              agentRuntimeId,
              commitValue: `${provider}/model`,
              disabled: true,
              unavailableReason: "missing-auth",
              isDefault: true,
              label: "Model",
              provider,
              value: `${provider}/model`,
            },
          ],
          open: true,
          selectedModelValue: `${provider}/model`,
          sessionModelPinned: false,
          sessionKey: "main",
          triggerModelLabel: "Model",
          onModelSelect: async () => {},
          onModelSetup: () => {},
        }),
        container,
      );
      expect(
        container.querySelector(".chat-controls__model-catalog-state-label")?.textContent?.trim(),
      ).toBe(label);
      expect(container.querySelector("[data-chat-model-setup]")).not.toBeNull();
    },
  );
});
