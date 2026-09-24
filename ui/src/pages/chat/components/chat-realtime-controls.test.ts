import type { TalkVoiceSelection } from "@openclaw/gateway-protocol";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectPicker } from "../../../components/select-picker.ts";
import { renderRealtimeVoicePicker } from "./chat-realtime-controls.ts";

const selection: TalkVoiceSelection = {
  voiceSessionId: "voice-1",
  sessionKey: "agent:main:voice",
  provider: "openai",
  model: "gpt-live-1-codex",
  voice: "cove",
  voices: ["cove", "spruce"],
  canChange: true,
};

describe("in-call voice picker", () => {
  afterEach(() => document.body.replaceChildren());
  it("selects a listed voice through the shared picker action", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onChange = vi.fn();
    render(renderRealtimeVoicePicker({ selection, onChange }), container);
    const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
    await picker.updateComplete;
    picker.querySelector<HTMLButtonElement>("button")!.click();
    await picker.updateComplete;
    picker.querySelector<HTMLElement>('[data-value="spruce"]')!.click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("spruce");
  });

  it.each(["changing", "unavailable"])(
    "keeps voice choices disabled while %s",
    async (condition) => {
      const container = document.createElement("div");
      document.body.append(container);
      const onChange = vi.fn();
      render(
        renderRealtimeVoicePicker({
          selection: { ...selection, canChange: condition !== "unavailable" },
          changing: condition === "changing",
          onChange,
        }),
        container,
      );
      const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
      await picker.updateComplete;
      expect(picker.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("shows Provider default instead of selecting the first listed voice", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      renderRealtimeVoicePicker({
        selection: { ...selection, voice: undefined },
        onChange: vi.fn(),
      }),
      container,
    );
    const picker = container.querySelector<SelectPicker>("openclaw-select-picker")!;
    await picker.updateComplete;
    expect(picker.querySelector("button")?.textContent).toContain("Provider default");
    expect(picker.querySelector("button")?.textContent).not.toContain("cove");
  });
});
