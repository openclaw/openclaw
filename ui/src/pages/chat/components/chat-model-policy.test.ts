/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ModelCatalogResult } from "../../../api/types.ts";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatModelControls } from "./chat-model-controls.tsx";
import {
  expandModelProviders,
  modelControlSelector,
  waitForModelMenu,
} from "./chat-model-picker.test-support.tsx";

const models = ["primary", "fallback", "custom"].map((id) => ({
  id,
  name: `Permitted ${id}`,
  provider: "fixture",
  available: true,
}));

async function mountControls(catalog: ModelCatalogResult, retired = false) {
  installModelPickerLayout();
  const sessions = createSessionsListResult({
    model: "forbidden-current",
    modelProvider: "fixture",
    defaultsModel: "forbidden-default",
    defaultsProvider: "fixture",
  });
  const selectedSession = { ...sessions.sessions[0]!, modelOverrideSource: "user" as const };
  const onModelSelect = vi.fn(async () => undefined);
  const before = JSON.stringify(selectedSession);
  const { container } = mountSolid(() =>
    createComponent(ChatModelControls, {
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
      modelPickerOpen: true,
      sending: false,
      sessionKey: "main",
      selectedSession,
      sessionsResult: sessions,
      stream: null,
      onModelSelect,
      onModelSetup: vi.fn(),
    }),
  );
  flush();
  await waitForModelMenu(container);
  expandModelProviders(container);
  expect(JSON.stringify(selectedSession)).toBe(before);
  const control = (kind: string, value?: string) =>
    container.querySelector<HTMLElement>(modelControlSelector(kind, value));
  return { container, onModelSelect, control };
}

it.each([undefined, "fixture/primary", "fixture/automatic", null])(
  "uses only catalog choices and the canonical default %s",
  async (defaultModel) => {
    const restricted = defaultModel !== undefined;
    const { container, onModelSelect, control } = await mountControls({
      models,
      ...(restricted ? { modelSelectionPolicy: { restricted: true as const, defaultModel } } : {}),
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
    control("option", "fixture/custom")?.click();
    expect(onModelSelect).toHaveBeenCalledWith("fixture/custom", "main", undefined);
    if (restricted) {
      expect(container.textContent).not.toContain("forbidden");
      expect(control("policy")?.textContent).toContain("administrator");
      const reset = control("default", "true");
      if (defaultModel) {
        expect(reset?.getAttribute("data-chat-model-option")).toBe(defaultModel);
        reset?.click();
        expect(onModelSelect).toHaveBeenCalledWith("", "main", null);
      } else {
        expect(reset).toBeNull();
        expect(control("select")?.textContent).toContain("Choose a model");
      }
    }
  },
);

it.each([false, true])(
  "hides forbidden choices in an empty catalog (retired=%s)",
  async (retired) => {
    const { container, control } = await mountControls(
      {
        models: [],
        ...(retired
          ? {}
          : { modelSelectionPolicy: { restricted: true as const, defaultModel: null } }),
      },
      retired,
    );
    expect(control("option")).toBeNull();
    if (retired) {
      expect(container.textContent).not.toContain("forbidden");
    } else {
      expect(container.textContent).toContain("No models are permitted by your administrator.");
      expect(control("setup")).toBeNull();
    }
  },
);

it("retains permitted runtime alternatives without offering denied ones", async () => {
  const { control } = await mountControls({
    models: [
      {
        ...models[0]!,
        runtimeChoices: [true, false].map((manualSelectionAllowed) => ({
          agentRuntime: {
            id: manualSelectionAllowed ? "permitted-route" : "denied-route",
            source: "provider" as const,
          },
          manualSelectionAllowed,
        })),
      },
    ],
    modelSelectionPolicy: { restricted: true, defaultModel: "fixture/primary" },
  });
  expect(control("runtime", "permitted-route")).not.toBeNull();
  expect(control("runtime", "denied-route")).toBeNull();
});
