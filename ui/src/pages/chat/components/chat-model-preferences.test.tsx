/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createSignal } from "solid-js";
import { beforeAll, expect, it, onTestFinished, vi } from "vitest";
import type { CyberAccessProgram } from "../../../api/types.ts";
import { i18n } from "../../../i18n/index.ts";
import { captureI18nStateForTesting } from "../../../i18n/lib/translate.test-support.ts";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatModelControls } from "./chat-model-controls.tsx";

type Props = Parameters<typeof ChatModelControls>[0];

// Cold loading is covered by browser proof; these cases exercise the loaded controls.
beforeAll(async () => {
  await Promise.all([
    import("./chat-model-picker-panel.tsx"),
    import("./chat-effort-picker-panel.tsx"),
  ]);
});

async function controls(overrides: Partial<Props>) {
  installModelPickerLayout();
  const sessions = createSessionsListResult({ model: "primary", modelProvider: "example" });
  const selectedSession = {
    ...sessions.sessions[0]!,
    thinkingLevel: "high",
    thinkingLevels: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
  };
  const onModelSelect = vi.fn(async () => true);
  const onThinkingSelect = vi.fn(async () => true);
  const onFastModeSelect = vi.fn(async () => true);
  const props: Props = {
    activeRunId: null,
    connected: true,
    gatewayAvailable: true,
    loading: false,
    modelSwitching: false,
    modelPickerOpen: true,
    modelCatalogState: { hasSnapshot: true, status: "ready" },
    sending: false,
    stream: null,
    sessionKey: "main",
    modelCatalog: ["primary", "other"].map((id) => ({
      id,
      name: id,
      provider: "example",
      supportsFastMode: true,
    })),
    selectedSession,
    thinkingSession: selectedSession,
    sessionsResult: sessions,
    onModelSelect,
    onThinkingSelect,
    onFastModeSelect,
    ...overrides,
  };
  const [current, setCurrent] = createSignal(props);
  const { container } = mountSolid(() => <ChatModelControls {...current()} />);
  const picker = container.querySelector<HTMLDetailsElement>(".chat-controls__effort-picker")!;
  picker.open = true;
  picker.dispatchEvent(new Event("toggle"));
  flush();
  await waitForSolid(() => {
    expect(container.querySelector(".chat-controls__model-menu")).not.toBeNull();
    expect(container.querySelector("[data-chat-thinking-slider]")).not.toBeNull();
  });
  const update = (next: Partial<Props>) => {
    setCurrent({ ...current(), ...next });
    flush();
  };
  return {
    container,
    update,
    onModelSelect,
    onThinkingSelect,
    onFastModeSelect,
    model: expectDefined(container.querySelector<HTMLElement>("[data-chat-model-select]"), "model"),
    option: expectDefined(
      container.querySelector<HTMLButtonElement>('[data-chat-model-option="example/other"]'),
      "model option",
    ),
    effort: expectDefined(
      container.querySelector<HTMLElement>("[data-chat-thinking-select]"),
      "effort",
    ),
    slider: expectDefined(
      container.querySelector<HTMLInputElement>("[data-chat-thinking-slider]"),
      "slider",
    ),
    speed: expectDefined(
      container.querySelector<HTMLButtonElement>("[data-chat-speed-option=on]"),
      "speed",
    ),
  };
}

it.each([
  { name: "sending", sending: true },
  { name: "preparing", activeRunId: "active-run" },
  { name: "streaming", stream: "A reply in progress" },
])("edits model, reasoning, and speed preferences while $name", async (busy) => {
  const {
    model,
    option,
    effort,
    slider,
    speed,
    onModelSelect,
    onThinkingSelect,
    onFastModeSelect,
  } = await controls(busy);
  expect(model.getAttribute("aria-disabled")).toBe("false");
  expect(effort.getAttribute("aria-disabled")).toBe("false");
  option.click();
  expect(onModelSelect).toHaveBeenCalledWith("example/other", "main", undefined);
  expect(slider.disabled).toBe(false);
  slider.value = "0";
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onThinkingSelect).toHaveBeenCalledWith("low", "main");
  expect(speed.disabled).toBe(false);
  speed.click();
  expect(onFastModeSelect).toHaveBeenCalledWith("on", "main");
});

it.each([
  { name: "offline", connected: false },
  { name: "missing backend", gatewayAvailable: false },
  { name: "model switch", modelSwitching: true },
  {
    name: "write denied",
    modelMutationDisabledReason: "Read only",
    effortMutationDisabledReason: "Read only",
  },
])("retains $name guards during an active response", async (guard) => {
  const { model, option, slider, onModelSelect, onThinkingSelect } = await controls({
    ...guard,
    activeRunId: "active-run",
    stream: "Working",
  });
  expect(model.getAttribute("aria-disabled")).toBe("true");
  expect(slider.disabled).toBe(true);
  option.click();
  slider.value = "0";
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onModelSelect).not.toHaveBeenCalled();
  expect(onThinkingSelect).not.toHaveBeenCalled();
});

it("retires and restores an unavailable context-window control with its access guard", async () => {
  const contextWindowTarget = {
    contextWindow: "standard",
    contextWindowDefault: "standard",
    contextWindows: [
      { id: "standard", label: "Standard", contextWindow: 100_000 },
      { id: "extended", label: "Extended", contextWindow: 200_000 },
    ],
  };
  const view = await controls({
    contextWindowTarget,
    contextWindowMutationDisabledReason: "Admin only",
  });
  expect(
    view.container.querySelector<HTMLButtonElement>("[data-chat-context-window-toggle]")?.disabled,
  ).toBe(true);
  view.update({ contextWindowTarget: { contextWindows: [] } });
  expect(view.container.querySelector("[data-chat-context-window-toggle]")).toBeNull();
  view.update({ contextWindowTarget });
  expect(
    view.container.querySelector<HTMLButtonElement>("[data-chat-context-window-toggle]")?.disabled,
  ).toBe(true);
});

it("refreshes context choices when a replaced session has unchanged model facts", async () => {
  const sessionsResult = createSessionsListResult({ model: "primary", modelProvider: "example" });
  const contextWindows = [
    { id: "standard", label: "Standard", contextWindow: 100_000 },
    { id: "extended", label: "Extended", contextWindow: 200_000 },
  ];
  const selectedSession = {
    ...sessionsResult.sessions[0]!,
    contextWindow: "standard",
    contextWindowDefault: "standard",
    contextWindows,
  };
  const onContextWindowSelect = vi.fn();
  const view = await controls({ selectedSession, sessionsResult, onContextWindowSelect });
  const toggle = () =>
    expectDefined(
      view.container.querySelector<HTMLButtonElement>("[data-chat-context-window-toggle]"),
      "context window toggle",
    );
  expect(toggle().getAttribute("aria-checked")).toBe("false");

  view.update({ selectedSession: { ...selectedSession, contextWindow: "extended" } });
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  toggle().click();
  expect(onContextWindowSelect).toHaveBeenCalledExactlyOnceWith("standard", "main");

  view.update({ selectedSession: { ...selectedSession, contextWindows: [] } });
  expect(view.container.querySelector("[data-chat-context-window-toggle]")).toBeNull();
});

it("updates model selection against a retained and replaced catalog", async () => {
  const view = await controls({});
  const option = (id: string) =>
    view.container.querySelector<HTMLButtonElement>(`[data-chat-model-option="example/${id}"]`);
  const selectSession = (model: string) => {
    const sessions = createSessionsListResult({
      model,
      modelProvider: "example",
      modelOverrideSource: "user",
    });
    view.update({ selectedSession: sessions.sessions[0], sessionsResult: sessions });
  };

  selectSession("other");
  await waitForSolid(() => {
    expect(option("other")?.getAttribute("aria-selected")).toBe("true");
    expect(option("primary")?.getAttribute("aria-selected")).toBe("false");
  });

  view.update({
    modelCatalog: [
      { id: "other", name: "Other refreshed", provider: "example", supportsFastMode: true },
      { id: "replacement", name: "Replacement", provider: "example", supportsFastMode: true },
    ],
  });
  await waitForSolid(() => {
    expect(option("other")?.textContent).toContain("Other refreshed");
    expect(option("replacement")).not.toBeNull();
    expect(option("primary")).toBeNull();
  });

  selectSession("replacement");
  await waitForSolid(() => {
    expect(option("replacement")?.getAttribute("aria-selected")).toBe("true");
    expect(option("other")?.getAttribute("aria-selected")).toBe("false");
    expect(view.model.textContent).toContain("Replacement");
  });
  expectDefined(option("other"), "refreshed model option").click();
  expect(view.onModelSelect).toHaveBeenCalledWith("example/other", "main", undefined);
});

it("refreshes provider account labels when the locale changes without new props", async () => {
  const restoreI18n = captureI18nStateForTesting();
  onTestFinished(restoreI18n);
  await i18n.setLocale("en");
  const view = await controls({
    modelSelectionTarget: "session",
    modelAuthStatusResult: {
      ts: 1,
      providers: [
        {
          provider: "example",
          displayName: "Example",
          status: "ok",
          profiles: [{ profileId: "example:oauth", type: "oauth", status: "ok" }],
        },
      ],
    },
  });
  const label = () =>
    view.container.querySelector(
      '[data-chat-model-provider-group="example"] .chat-controls__auth-meta-label',
    )?.textContent;
  expect(label()).toBe("Subscription");
  await i18n.setLocale("de");
  await waitForSolid(() => expect(label()).toBe("Abonnement"));
});

it("refreshes a retained session model when the containing frame changes", async () => {
  const sessions = createSessionsListResult({ model: "primary", modelProvider: "example" });
  const selectedSession = { ...sessions.sessions[0]!, modelOverrideSource: "user" as const };
  const view = await controls({ selectedSession });
  expect(view.model.textContent).toContain("primary");

  selectedSession.model = "other";
  view.update({ stream: "A new activity frame" });
  await waitForSolid(() => {
    expect(view.model.textContent).toContain("other");
    expect(view.option.getAttribute("aria-selected")).toBe("true");
  });
});

it("refreshes saved and effective speed on a retained target when the frame changes", async () => {
  const fastModeTarget: NonNullable<Props["fastModeTarget"]> = {
    model: "primary",
    modelProvider: "example",
    fastMode: false,
    effectiveFastMode: false,
  };
  const view = await controls({ fastModeTarget });
  expect(view.speed.getAttribute("aria-checked")).toBe("false");

  fastModeTarget.fastMode = true;
  fastModeTarget.effectiveFastMode = true;
  view.update({ stream: "Saved speed refreshed" });
  expect(view.speed.getAttribute("aria-checked")).toBe("true");
  expectDefined(
    view.container.querySelector<HTMLButtonElement>("[data-chat-speed-option=off]"),
    "standard speed option",
  ).click();
  expect(view.onFastModeSelect).toHaveBeenCalledWith("off", "main");

  fastModeTarget.effectiveFastMode = false;
  view.update({ stream: "Effective speed refreshed" });
  expect(view.speed.getAttribute("aria-checked")).toBe("false");
});

it("keeps known effort visible but disabled until the same connection returns", async () => {
  const view = await controls({});
  const picker = view.container.querySelector<HTMLDetailsElement>(".chat-controls__effort-picker")!;
  expect(view.effort.textContent).toContain("High");
  view.update({ connected: false, modelCatalogState: { hasSnapshot: true, status: "offline" } });
  expect(picker.getAttribute("aria-hidden")).toBe("false");
  expect(picker.hasAttribute("inert")).toBe(false);
  expect(view.effort.textContent).toContain("High");
  expect(view.effort.getAttribute("aria-disabled")).toBe("true");
  expect(view.slider.disabled).toBe(true);
  expect(view.speed.disabled).toBe(true);
  view.slider.value = "0";
  view.slider.dispatchEvent(new Event("change", { bubbles: true }));
  view.speed.click();
  expect(view.onThinkingSelect).not.toHaveBeenCalled();
  expect(view.onFastModeSelect).not.toHaveBeenCalled();
  view.update({ connected: true, modelCatalogState: { hasSnapshot: true, status: "ready" } });
  expect(view.effort.textContent).toContain("High");
  expect(view.effort.getAttribute("aria-disabled")).toBe("false");
  expect(view.slider.disabled).toBe(false);
});

it.each([
  { hasSnapshot: false, initialized: false, status: "offline" as const },
  { hasSnapshot: false, retired: true, status: "offline" as const },
])("does not expose effort without an admitted catalog snapshot: %j", async (modelCatalogState) => {
  const view = await controls({});
  view.update({ connected: false, modelCatalog: [], modelCatalogState });
  const picker = view.container.querySelector(".chat-controls__effort-picker")!;
  expect(picker.getAttribute("aria-hidden")).toBe("true");
  expect(picker.hasAttribute("inert")).toBe(true);
});

it("does not invent reasoning options for an offline non-reasoning model", async () => {
  const view = await controls({});
  const selectedSession = {
    key: "main",
    kind: "direct" as const,
    updatedAt: 1,
    model: "plain",
    modelProvider: "example",
    thinkingLevels: [],
    thinkingDefault: "off",
  };
  view.update({
    connected: false,
    modelCatalog: [
      {
        id: "plain",
        name: "Plain",
        provider: "example",
        reasoning: false,
        thinkingLevels: [],
        thinkingDefault: "off",
      },
    ],
    modelCatalogState: { hasSnapshot: true, status: "offline" },
    selectedSession,
    thinkingSession: selectedSession,
  });
  expect(view.container.querySelector("[data-chat-thinking-select]")).toBeNull();
});

it("never borrows access entitlement from another runtime or a retired catalog", async () => {
  const model = {
    id: "primary",
    name: "primary",
    provider: "example",
    supportsFastMode: true,
    agentRuntime: { id: "openclaw", source: "model" as const },
    availableAccessPrograms: {
      cyber: ["standard", "daybreak_blue"] satisfies CyberAccessProgram[],
    },
    runtimeChoices: [{ agentRuntime: { id: "codex", source: "model" as const } }],
  };
  const view = await controls({
    modelCatalog: [model, { id: "other", name: "other", provider: "example" }],
    selectedAgentRuntime: "codex",
    requestedAccessProgram: "daybreak_red",
    onAccessProgramSelect: vi.fn(),
  });
  const accessOptions = () =>
    Array.from(
      view.container.querySelectorAll<HTMLButtonElement>("[data-chat-access-option]"),
      (option) => option.getAttribute("data-chat-access-option"),
    );
  expect(accessOptions()).toEqual([]);
  view.update({ selectedAgentRuntime: "openclaw" });
  expect(accessOptions()).toEqual(["standard", "daybreak_blue"]);
  view.update({ modelCatalogState: { hasSnapshot: true, status: "loading", retired: true } });
  expect(accessOptions()).toEqual([]);
  const unknownModel = { ...model, availableAccessPrograms: undefined };
  view.update({
    modelCatalogState: { hasSnapshot: true, status: "ready" },
    modelCatalog: [unknownModel],
  });
  expect(accessOptions()).toEqual([]);
});
