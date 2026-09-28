/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogResult } from "../../../api/types.ts";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { renderChatModelControls } from "./chat-model-controls.ts";

const models = ["primary", "fallback", "custom"].map((id) => ({
  id,
  name: `Permitted ${id}`,
  provider: "fixture",
  available: true,
}));

function mountControls(catalog: ModelCatalogResult, retired = false) {
  const container = document.createElement("div");
  const sessions = createSessionsListResult({
    model: "forbidden-current",
    modelProvider: "fixture",
    defaultsModel: "forbidden-default",
    defaultsProvider: "fixture",
  });
  const selectedSession = { ...sessions.sessions[0]!, modelOverrideSource: "user" as const };
  const onModelSelect = vi.fn(async () => undefined);
  const before = JSON.stringify(selectedSession);
  render(
    renderChatModelControls({
      activeRunId: null,
      connected: true,
      gatewayAvailable: true,
      loading: false,
      modelCatalog: catalog.models,
      modelCatalogState: {
        hasSnapshot: !retired,
        status: retired ? "loading" : "ready",
        retired,
        modelSelectionPolicy: catalog.modelSelectionPolicy,
      },
      modelSwitching: false,
      sending: false,
      sessionKey: "main",
      selectedSession,
      sessionsResult: sessions,
      stream: null,
      onModelSelect,
      onModelSetup: vi.fn(),
    }),
    container,
  );
  expect(JSON.stringify(selectedSession)).toBe(before);
  return { container, onModelSelect };
}

describe("server-owned model selection policy", () => {
  it.each([false, true])("renders only permitted choices when restricted=%s", (restricted) => {
    const { container, onModelSelect } = mountControls({
      models,
      ...(restricted
        ? { modelSelectionPolicy: { restricted: true as const, defaultModel: "fixture/primary" } }
        : {}),
    });
    const values = Array.from(container.querySelectorAll("[data-chat-model-option]"), (row) =>
      row.getAttribute("data-chat-model-option"),
    );
    const expected = restricted
      ? ["fixture/primary", "fixture/fallback", "fixture/custom"]
      : [
          "fixture/forbidden-default",
          "fixture/primary",
          "fixture/fallback",
          "fixture/custom",
          "fixture/forbidden-current",
        ];
    expect(values).toHaveLength(expected.length);
    expect(values).toEqual(expect.arrayContaining(expected));
    container
      .querySelector<HTMLButtonElement>('[data-chat-model-option="fixture/custom"]')
      ?.click();
    expect(onModelSelect).toHaveBeenCalledWith("fixture/custom", "main", undefined);
    if (restricted) {
      expect(container.textContent).not.toContain("forbidden");
      expect(container.querySelector("[data-chat-model-policy]")?.textContent).toContain(
        "administrator",
      );
    }
  });

  it.each(["fixture/automatic", null])("uses only the canonical default %s", (defaultModel) => {
    const { container, onModelSelect } = mountControls({
      models,
      modelSelectionPolicy: { restricted: true, defaultModel },
    });
    const reset = container.querySelector<HTMLButtonElement>('[data-chat-model-default="true"]');
    if (defaultModel) {
      expect(reset?.getAttribute("data-chat-model-option")).toBe(defaultModel);
      reset?.click();
      expect(onModelSelect).toHaveBeenCalledWith("", "main", null);
    } else {
      expect(reset).toBeNull();
      expect(container.querySelector("[data-chat-model-select]")?.textContent).toContain(
        "Choose a model",
      );
    }
  });

  it("explains an empty restricted catalog without offering model setup", () => {
    const { container } = mountControls({
      models: [],
      modelSelectionPolicy: { restricted: true, defaultModel: null },
    });
    expect(container.textContent).toContain("No models are permitted by your administrator.");
    expect(container.querySelector("[data-chat-model-setup]")).toBeNull();
    expect(container.querySelector("[data-chat-model-option]")).toBeNull();
  });

  it("retires raw session and default labels before a replacement policy arrives", () => {
    const { container } = mountControls({ models: [] }, true);
    expect(container.textContent).not.toContain("forbidden");
    expect(container.querySelector("[data-chat-model-option]")).toBeNull();
  });

  it("retains permitted runtime alternatives without offering denied ones", () => {
    const { container } = mountControls({
      models: [
        {
          ...models[0]!,
          runtimeChoices: [
            {
              agentRuntime: { id: "permitted-route", source: "provider" },
              manualSelectionAllowed: true,
            },
            {
              agentRuntime: { id: "denied-route", source: "provider" },
              manualSelectionAllowed: false,
            },
          ],
        },
      ],
      modelSelectionPolicy: { restricted: true, defaultModel: "fixture/primary" },
    });
    expect(container.querySelector('[data-chat-model-runtime="permitted-route"]')).not.toBeNull();
    expect(container.querySelector('[data-chat-model-runtime="denied-route"]')).toBeNull();
  });
});
