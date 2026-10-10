/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { expect, it, vi } from "vitest";
import { createSessionsListResult } from "../../../test-helpers/chat-model.ts";
import { renderChatModelControls } from "./chat-model-controls.ts";

type Props = Parameters<typeof renderChatModelControls>[0];

function controls(overrides: Partial<Props>) {
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
  const container = document.createElement("div");
  render(
    renderChatModelControls({
      activeRunId: null,
      activeRunSessionKey: "main",
      connected: true,
      gatewayAvailable: true,
      loading: false,
      modelSwitching: false,
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
    }),
    container,
  );
  return {
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
])("edits model and reasoning preferences while $name without enabling speed", (busy) => {
  const {
    model,
    option,
    effort,
    slider,
    speed,
    onModelSelect,
    onThinkingSelect,
    onFastModeSelect,
  } = controls(busy);
  expect(model.getAttribute("aria-disabled")).toBe("false");
  expect(effort.getAttribute("aria-disabled")).toBe("false");
  option.click();
  expect(onModelSelect).toHaveBeenCalledWith("example/other", "main", undefined);
  expect(slider.disabled).toBe(false);
  slider.value = "0";
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onThinkingSelect).toHaveBeenCalledWith("low", "main");
  expect(speed.disabled).toBe(true);
  speed.click();
  expect(onFastModeSelect).not.toHaveBeenCalled();
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
])("retains $name guards during an active response", (guard) => {
  const { model, option, slider, onModelSelect, onThinkingSelect } = controls({
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
