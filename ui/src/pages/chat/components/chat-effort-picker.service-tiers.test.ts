import { nothing, render } from "lit";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry } from "../../../api/types.ts";
import { resolveChatFastModeSelectState } from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { ChatEffortPicker } from "./chat-effort-picker.tsx";

const host = document.createElement("div");

afterEach(() => render(nothing, host));

it("keeps Ultrafast selectable while showing and clearing a provider downgrade", () => {
  const onFastModeSelect = vi.fn(async () => undefined);
  const model: ModelCatalogEntry = {
    id: "model",
    name: "Model",
    provider: "openai",
    available: true,
    supportsFastMode: true,
    supportsServiceTierRecovery: true,
    serviceTiers: ["priority", "ultrafast"],
  };
  const show = (
    fastMode: true | "ultrafast",
    serviceTierObservation?: ModelCatalogEntry["serviceTierObservation"],
  ) => {
    render(
      solidTemplate(ChatEffortPicker, {
        disabled: false,
        thinkingDisabled: false,
        sessionKey: "tier-observation",
        thinking: resolveChatThinkingSelectState({
          catalog: [],
          sessionKey: "tier-observation",
          sessionsResult: null,
        }),
        fastMode: resolveChatFastModeSelectState({
          activeRunId: null,
          catalog: [{ ...model, serviceTierObservation }],
          connected: true,
          currentModelOverride: "openai/model",
          fastModeTarget: { model: "model", modelProvider: "openai", fastMode },
          gatewayAvailable: true,
          loading: false,
          sending: false,
          sessionsResult: null,
          stream: null,
        }),
        onFastModeSelect,
        onThinkingSelect: vi.fn(async () => undefined),
      }),
      host,
    );
    return host.querySelector<HTMLButtonElement>('[data-chat-speed-option="ultrafast"]')!;
  };
  const observation = { requestedTier: "ultrafast", responseTier: "priority" };
  const ultrafast = show("ultrafast", observation);
  expect(ultrafast.disabled).toBe(false);
  expect(ultrafast.getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("summary")!.title).toContain(
    "Ultrafast requested, currently served as priority",
  );

  show("ultrafast", { requestedTier: "ultrafast" });
  expect(host.querySelector("summary")!.title).toContain(
    "Ultrafast requested, currently unavailable",
  );

  show(true, observation).click();
  expect(onFastModeSelect).toHaveBeenCalledWith("ultrafast", "tier-observation");
  expect(host.querySelector("summary")!.title).not.toContain("requested");

  expect(show("ultrafast").getAttribute("aria-checked")).toBe("true");
  expect(host.querySelector("summary")!.title).toBe("Speed: Ultrafast");
});

it("keeps an uncommitted reasoning preview when other picker props refresh", () => {
  document.body.append(host);
  onTestFinished(() => host.remove());
  const onThinkingSelect = vi.fn(async () => undefined);
  const paint = (active: boolean) =>
    render(
      solidTemplate(ChatEffortPicker, {
        disabled: false,
        thinkingDisabled: false,
        sessionKey: "reasoning-preview",
        thinking: resolveChatThinkingSelectState({
          catalog: [],
          sessionKey: "reasoning-preview",
          sessionsResult: null,
          session: {
            thinkingDefault: "high",
            thinkingLevels: ["low", "high", "ultra"].map((id) => ({ id, label: id })),
          },
        }),
        fastMode: {
          active,
          currentOverride: active ? "on" : "off",
          disabled: false,
          label: active ? "On" : "Off",
          nextValue: active ? "off" : "on",
          supported: true,
        },
        onFastModeSelect: async () => undefined,
        onThinkingSelect,
      }),
      host,
    );
  paint(false);
  const slider = host.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")!;
  slider.value = "2";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  expect(slider.getAttribute("aria-valuetext")).toBe("Ultra");
  paint(true);
  expect(host.querySelector("[data-chat-thinking-slider]")).toBe(slider);
  expect(slider.value).toBe("2");
  expect(slider.getAttribute("aria-valuetext")).toBe("Ultra");
  expect(onThinkingSelect).not.toHaveBeenCalled();
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("ultra", "reasoning-preview");
});
