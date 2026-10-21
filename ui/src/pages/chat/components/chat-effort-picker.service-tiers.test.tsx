import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry } from "../../../api/types.ts";
import { resolveChatFastModeSelectState } from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatEffortPicker } from "./chat-effort-picker.tsx";

const host = document.createElement("div");
const summary = () => host.querySelector<HTMLElement>("summary")!;
beforeEach(() => {
  document.body.append(host);
  onTestFinished(() => host.remove());
});
function openPicker() {
  summary().click();
  flush();
}

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
  const options = (
    fastMode: true | "ultrafast",
    serviceTierObservation?: ModelCatalogEntry["serviceTierObservation"],
  ): Parameters<typeof ChatEffortPicker>[0] => ({
    disabled: false,
    thinkingDisabled: false,
    sessionKey: "tier-observation",
    thinking: resolveChatThinkingSelectState({
      catalog: [],
      sessionKey: "tier-observation",
      sessionsResult: null,
    }),
    fastMode: resolveChatFastModeSelectState({
      catalog: [{ ...model, serviceTierObservation }],
      connected: true,
      currentModelOverride: "openai/model",
      fastModeTarget: { model: "model", modelProvider: "openai", fastMode },
      gatewayAvailable: true,
      loading: false,
      sessionsResult: null,
    }),
    onFastModeSelect,
    onThinkingSelect: vi.fn(async () => undefined),
  });
  const view = mountSolid(ChatEffortPicker, options("ultrafast"), host);
  const show = (
    fastMode: true | "ultrafast",
    observation?: ModelCatalogEntry["serviceTierObservation"],
  ) => {
    view.update(options(fastMode, observation));
    return host.querySelector<HTMLButtonElement>('[data-chat-speed-option="ultrafast"]')!;
  };
  const observation = { requestedTier: "ultrafast", responseTier: "priority" };
  openPicker();
  const ultrafast = show("ultrafast", observation);
  expect([ultrafast.disabled, ultrafast.getAttribute("aria-checked")]).toEqual([false, "true"]);
  expect(summary().title).toContain("Ultrafast requested, currently served as priority");

  show("ultrafast", { requestedTier: "ultrafast" });
  expect(summary().title).toContain("Ultrafast requested, currently unavailable");

  show(true, observation).click();
  expect(onFastModeSelect).toHaveBeenCalledWith("ultrafast", "tier-observation");
  expect(summary().title).not.toContain("requested");

  expect(show("ultrafast").getAttribute("aria-checked")).toBe("true");
  expect(summary().title).toBe("Speed: Ultrafast");
});

it("keeps an uncommitted reasoning preview when other picker props refresh", () => {
  const onThinkingSelect = vi.fn(async () => undefined);
  const options = (active: boolean): Parameters<typeof ChatEffortPicker>[0] => ({
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
      persistedOverride: active ? "on" : "off",
      disabled: false,
      label: active ? "On" : "Off",
      nextValue: active ? "off" : "on",
      supported: true,
    },
    onFastModeSelect: async () => undefined,
    onThinkingSelect,
  });
  const view = mountSolid(ChatEffortPicker, options(false), host);
  openPicker();
  const slider = host.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")!;
  slider.value = "2";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(slider.getAttribute("aria-valuetext")).toBe("Ultra");
  view.update(options(true));
  expect(host.querySelector("[data-chat-thinking-slider]")).toBe(slider);
  expect([slider.value, slider.getAttribute("aria-valuetext")]).toEqual(["2", "Ultra"]);
  expect(onThinkingSelect).not.toHaveBeenCalled();
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("ultra", "reasoning-preview");
});
