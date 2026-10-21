/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { expect, it, vi } from "vitest";
import type { ModelCatalogResult } from "../../../api/types.ts";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatModelControls } from "./chat-model-controls.tsx";
import { modelControlSelector, waitForModelMenu } from "./chat-model-picker.test-support.tsx";

const models = ["primary", "fallback", "custom"].map((id) => ({
  id,
  name: `Permitted ${id}`,
  provider: "fixture",
  available: true,
}));

async function mountControls(catalog: ModelCatalogResult, retired = false) {
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
  expect(JSON.stringify(selectedSession)).toBe(before);
  return { container, onModelSelect };
}

it.each([undefined, "fixture/primary", "fixture/automatic", null])(
  "uses only catalog choices and the canonical default %s",
  async (defaultModel) => {
    const restricted = defaultModel !== undefined;
    const { container, onModelSelect } = await mountControls({
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
    container
      .querySelector<HTMLButtonElement>(modelControlSelector("option", "fixture/custom"))
      ?.click();
    expect(onModelSelect).toHaveBeenCalledWith("fixture/custom", "main", undefined);
    if (restricted) {
      expect(container.textContent).not.toContain("forbidden");
      expect(
        container.querySelector<HTMLElement>(modelControlSelector("policy"))?.textContent,
      ).toContain("administrator");
      const reset = container.querySelector<HTMLButtonElement>(
        modelControlSelector("default", "true"),
      );
      if (defaultModel) {
        expect(reset?.getAttribute("data-chat-model-option")).toBe(defaultModel);
        reset?.click();
        expect(onModelSelect).toHaveBeenCalledWith("", "main", null);
      } else {
        expect(reset).toBeNull();
        expect(
          container.querySelector<HTMLElement>(modelControlSelector("select"))?.textContent,
        ).toContain("Choose a model");
      }
    }
  },
);

it.each([false, true])(
  "hides forbidden choices in an empty catalog (retired=%s)",
  async (retired) => {
    const { container } = await mountControls(
      {
        models: [],
        ...(retired
          ? {}
          : { modelSelectionPolicy: { restricted: true as const, defaultModel: null } }),
      },
      retired,
    );
    expect(container.querySelector<HTMLElement>(modelControlSelector("option"))).toBeNull();
    if (retired) {
      expect(container.textContent).not.toContain("forbidden");
    } else {
      expect(container.textContent).toContain("No models are permitted by your administrator.");
      expect(container.querySelector<HTMLElement>(modelControlSelector("setup"))).toBeNull();
    }
  },
);

it("retains permitted runtime alternatives without offering denied ones", async () => {
  const { container } = await mountControls({
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
  expect(
    container.querySelector<HTMLElement>(modelControlSelector("runtime", "permitted-route")),
  ).not.toBeNull();
  expect(
    container.querySelector<HTMLElement>(modelControlSelector("runtime", "denied-route")),
  ).toBeNull();
});
