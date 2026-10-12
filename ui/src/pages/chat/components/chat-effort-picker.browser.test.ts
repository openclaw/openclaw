import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveChatFastModeSelectState,
  type ChatFastModeSelectState,
} from "../../../lib/chat/model-select-state.ts";
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
  fastMode?: ChatFastModeSelectState,
) {
  host ??= document.body.appendChild(document.createElement("div"));
  const onThinkingSelect = vi.fn(async () => undefined);
  const onFastModeSelect = vi.fn(async () => undefined);
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
      fastMode: fastMode ?? {
        active: false,
        currentOverride: "",
        disabled: true,
        label: "Off",
        nextValue: "on",
        supported: false,
      },
      onFastModeSelect,
      onThinkingSelect,
    }),
    host,
  );
  const details = host.querySelector("details")!;
  if (!details.open) {
    const opened = new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
    });
    details.open = true;
    // The toggle handler activates the popup; hidden descendants have stale
    // computed styles in WebKit even after their Lit update completes.
    await opened;
  }
  await host.querySelector("wa-popup")!.updateComplete;
  expect(host.querySelector<HTMLInputElement>("input[type=range]")!.checkVisibility()).toBe(true);
  return {
    input: host.querySelector<HTMLInputElement>("input[type=range]")!,
    onThinkingSelect,
    onFastModeSelect,
  };
}

function appearance(input: HTMLInputElement) {
  return {
    fill: getComputedStyle(input.parentElement!).backgroundImage,
    glow: getComputedStyle(input).boxShadow,
  };
}

describe("effort bar colour and flow", () => {
  it("keeps speed names accessible without chip labels and only exposes entitled choices", async () => {
    const state = (mode: boolean | "ultrafast", tiers?: string[], supportsFastMode = true) =>
      resolveChatFastModeSelectState({
        activeRunId: null,
        connected: true,
        gatewayAvailable: true,
        loading: false,
        sending: false,
        stream: null,
        sessionsResult: null,
        currentModelOverride: "openai/model",
        fastModeTarget: { model: "model", modelProvider: "openai", fastMode: mode },
        catalog: [
          {
            id: "model",
            name: "Model",
            provider: "openai",
            available: true,
            supportsFastMode,
            supportsServiceTierRecovery: true,
            serviceTiers: tiers,
          },
        ],
      });
    await fixture(["low", "medium", "high"], "high", false, state(false));
    expect(host!.querySelector("summary")!.textContent?.trim()).toBe("High");
    expect(host!.querySelectorAll("[data-chat-speed-option]")).toHaveLength(2);
    expect(host!.textContent).not.toContain("higher usage");
    const { onFastModeSelect } = await fixture(
      ["low", "medium", "high"],
      "high",
      false,
      state("ultrafast", ["priority", "ultrafast"]),
    );
    expect(host!.querySelector("summary")!.textContent?.trim()).toBe("High");
    expect(host!.querySelector("summary")!.getAttribute("aria-label")).toContain(
      "High · Ultrafast",
    );
    expect(host!.querySelector("summary")!.title).toBe("High · Ultrafast");
    expect(
      [...host!.querySelectorAll("[data-chat-speed-option]")].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Standard", "Fast", "Ultrafast"]);
    const ultra = host!.querySelector<HTMLButtonElement>('[data-chat-speed-option="ultrafast"]')!;
    expect(ultra.getAttribute("aria-checked")).toBe("true");
    ultra.focus();
    ultra.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(onFastModeSelect).toHaveBeenLastCalledWith("on", "effort-preview");
    const standard = host!.querySelector<HTMLButtonElement>('[data-chat-speed-option="off"]')!;
    standard.click();
    expect(onFastModeSelect).toHaveBeenLastCalledWith("off", "effort-preview");
    await fixture(
      ["low", "medium", "high"],
      "high",
      false,
      state("ultrafast", ["priority", "ultrafast"], false),
    );
    expect(
      host!.querySelector<HTMLButtonElement>('[data-chat-speed-option="ultrafast"]')!.disabled,
    ).toBe(true);
    expect(host!.querySelector('[data-chat-speed-option="on"]')).toBeNull();
    const standardOnly = await fixture(
      ["low", "medium", "high"],
      "high",
      false,
      state("ultrafast", ["default"], false),
    );
    expect(
      host!.querySelector('[data-chat-speed-option="off"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    for (const option of host!.querySelectorAll<HTMLButtonElement>("[data-chat-speed-option]")) {
      expect(option.disabled).toBe(true);
      option.click();
    }
    expect(standardOnly.onFastModeSelect).not.toHaveBeenCalled();
    expect(standardOnly.input.disabled).toBe(false);
    expect(host!.querySelector(".chat-controls__effort-zap")).toBeNull();
    await fixture(["low", "medium", "high"], "high", false, state("ultrafast"));
    expect(
      host!.querySelector<HTMLButtonElement>('[data-chat-speed-option="ultrafast"]')!.disabled,
    ).toBe(true);
    expect(host!.querySelector("summary")!.getAttribute("aria-label")).toContain("Ultrafast");
    expect(
      host!.querySelector('[data-chat-speed-option="ultrafast"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(host!.querySelector('[data-chat-speed-option="off"]')?.getAttribute("tabindex")).toBe(
      "0",
    );
    expect(
      host!.querySelector('[data-chat-speed-option="ultrafast"]')?.getAttribute("tabindex"),
    ).toBe("-1");
  });

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
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(input.getAttribute("aria-valuetext")).toBe("Ultra");
      expect(appearance(input)).not.toEqual(maximumStyle);
      expect(onThinkingSelect).not.toHaveBeenCalled();
      input.dispatchEvent(new Event(resetEvent));
      expect(input.value).toBe("1");
      expect(input.getAttribute("aria-valuetext")).toContain("Maximum");
      expect(appearance(input)).toEqual(maximumStyle);
    }
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(appearance(input)).toEqual({ fill: "none", glow: "none" });
    input.dispatchEvent(new Event("change"));
    expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("low", "effort-preview");
    expect(appearance(input)).toEqual(maximumStyle);
  });
});
