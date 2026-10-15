import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ModelCatalogEntry } from "../../../api/types.ts";
import { resolveChatFastModeSelectState } from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ChatEffortPicker } from "./chat-effort-picker.tsx";

const host = document.createElement("div");

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
  let show!: (
    fastMode: true | "ultrafast",
    observation?: ModelCatalogEntry["serviceTierObservation"],
  ) => HTMLButtonElement;
  mountSolid(
    () => {
      const [props, setProps] = createSignal(options("ultrafast"));
      show = (mode, observation) => {
        setProps(() => options(mode, observation));
        flush();
        return host.querySelector<HTMLButtonElement>('[data-chat-speed-option="ultrafast"]')!;
      };
      return <ChatEffortPicker {...props()} />;
    },
    { container: host },
  );
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
  let paint!: (active: boolean) => void;
  mountSolid(
    () => {
      const [props, setProps] = createSignal(options(false));
      paint = (active) => {
        setProps(() => options(active));
        flush();
      };
      return <ChatEffortPicker {...props()} />;
    },
    { container: host },
  );
  paint(false);
  const slider = host.querySelector<HTMLInputElement>("[data-chat-thinking-slider]")!;
  slider.value = "2";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(slider.getAttribute("aria-valuetext")).toBe("Ultra");
  paint(true);
  expect(host.querySelector("[data-chat-thinking-slider]")).toBe(slider);
  expect(slider.value).toBe("2");
  expect(slider.getAttribute("aria-valuetext")).toBe("Ultra");
  expect(onThinkingSelect).not.toHaveBeenCalled();
  slider.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("ultra", "reasoning-preview");
});
