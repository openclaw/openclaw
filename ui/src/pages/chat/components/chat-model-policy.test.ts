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
  it.each([undefined, "fixture/primary", "fixture/automatic", null])(
    "uses only catalog choices and the canonical default %s",
    (defaultModel) => {
      const restricted = defaultModel !== undefined;
      const { container, onModelSelect } = mountControls({
        models,
        ...(restricted
          ? { modelSelectionPolicy: { restricted: true as const, defaultModel } }
          : {}),
      });
      const values = Array.from(container.querySelectorAll("[data-chat-model-option]"), (row) =>
        row.getAttribute("data-chat-model-option"),
      );
      const expected = ["fixture/primary", "fixture/fallback", "fixture/custom"];
      if (!restricted) {
        expected.push("fixture/forbidden-default", "fixture/forbidden-current");
      } else if (defaultModel === "fixture/automatic") {
        expected.push(defaultModel);
      }
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
        const reset = container.querySelector<HTMLButtonElement>(
          '[data-chat-model-default="true"]',
        );
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
      }
    },
  );

  it.each([false, true])("hides forbidden choices in an empty catalog (retired=%s)", (retired) => {
    const { container } = mountControls(
      {
        models: [],
        ...(retired
          ? {}
          : { modelSelectionPolicy: { restricted: true as const, defaultModel: null } }),
      },
      retired,
    );
    expect(container.querySelector("[data-chat-model-option]")).toBeNull();
    if (retired) {
      expect(container.textContent).not.toContain("forbidden");
    } else {
      expect(container.textContent).toContain("No models are permitted by your administrator.");
      expect(container.querySelector("[data-chat-model-setup]")).toBeNull();
    }
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
