import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { renderChatEffortPicker } from "./chat-effort-picker.ts";

let host: HTMLDivElement | undefined;

afterEach(() => {
  if (host) {
    render(nothing, host);
    host.remove();
    host = undefined;
  }
  document.documentElement.removeAttribute("data-theme-mode");
});

async function fixture(
  levels: Array<string | { id: string; label: string }>,
  value: string,
  inherited = false,
) {
  host ??= document.body.appendChild(document.createElement("div"));
  const onThinkingSelect = vi.fn(async () => undefined);
  render(
    renderChatEffortPicker({
      disabled: false,
      thinkingDisabled: false,
      sessionKey: "effort-preview",
      thinking: resolveChatThinkingSelectState({
        catalog: [],
        sessionKey: "effort-preview",
        sessionsResult: null,
        session: {
          thinkingLevel: inherited ? undefined : value,
          thinkingDefault: inherited ? value : "low",
          thinkingLevels: levels.map((level) =>
            typeof level === "string" ? { id: level, label: level } : level,
          ),
        },
      }),
      fastMode: {
        active: false,
        currentOverride: "",
        disabled: true,
        label: "Off",
        nextValue: "on",
        supported: false,
      },
      onFastModeSelect: async () => undefined,
      onThinkingSelect,
    }),
    host,
  );
  host.querySelector("details")!.open = true;
  await host.querySelector("wa-popup")!.updateComplete;
  return {
    input: host.querySelector<HTMLInputElement>("input[type=range]")!,
    onThinkingSelect,
  };
}

function appearance(input: HTMLInputElement) {
  return {
    fill: getComputedStyle(input.parentElement!).backgroundImage,
    glow: getComputedStyle(input).boxShadow,
  };
}

describe("effort bar colour and flow", () => {
  it.each(["dark", "light"])("highlights the highest discrete effort in %s mode", async (theme) => {
    document.documentElement.dataset.themeMode = theme;
    for (const maximum of ["high", "xhigh", "max"]) {
      const levels = ["off", "low", maximum, "adaptive", "ultra"];
      const { input } = await fixture(levels, maximum);
      const maximumStyle = appearance(input);
      expect(maximumStyle.fill).toContain("linear-gradient");
      expect(maximumStyle.glow).not.toBe("none");
      expect(appearance((await fixture(levels, maximum, true)).input)).toEqual(maximumStyle);
      const ultraStyle = appearance((await fixture(levels, "ultra")).input);
      expect(ultraStyle.fill).toContain("linear-gradient");
      expect(ultraStyle.fill).not.toBe(maximumStyle.fill);
      expect(ultraStyle.glow).not.toBe(maximumStyle.glow);
      for (const value of ["off", "low", "adaptive", "unsupported"]) {
        expect(appearance((await fixture(levels, value)).input)).toEqual({
          fill: "none",
          glow: "none",
        });
      }
    }
    expect(appearance((await fixture(["off", "on"], "on")).input)).toEqual({
      fill: "none",
      glow: "none",
    });
    for (const id of ["low", "high"]) {
      const { input } = await fixture(["off", { id, label: "on" }, "ultra"], id);
      expect(appearance(input)).toEqual({ fill: "none", glow: "none" });
    }
  });

  it("previews colour without committing and restores the committed level on cancel or blur", async () => {
    const { input, onThinkingSelect } = await fixture(["low", "max", "ultra"], "max", true);
    const maximumStyle = appearance(input);
    for (const resetEvent of ["pointercancel", "blur"]) {
      input.value = "2";
      input.dispatchEvent(new Event("input"));
      expect(input.getAttribute("aria-valuetext")).toBe("Ultra");
      expect(appearance(input)).not.toEqual(maximumStyle);
      expect(onThinkingSelect).not.toHaveBeenCalled();
      input.dispatchEvent(new Event(resetEvent));
      expect(input.value).toBe("1");
      expect(input.getAttribute("aria-valuetext")).toContain("Maximum");
      expect(appearance(input)).toEqual(maximumStyle);
    }
    input.value = "0";
    input.dispatchEvent(new Event("input"));
    expect(appearance(input)).toEqual({ fill: "none", glow: "none" });
    input.dispatchEvent(new Event("change"));
    expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("low", "effort-preview");
    expect(appearance(input)).toEqual(maximumStyle);
  });
});
