import { nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../../api/types.ts";
import { resolveChatFastModeSelectState } from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { renderChatEffortPicker } from "./chat-effort-picker.ts";

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
      renderChatEffortPicker({
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
