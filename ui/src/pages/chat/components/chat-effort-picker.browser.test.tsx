import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import {
  resolveChatFastModeSelectState,
  type ChatFastModeSelectState,
} from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { focusComposerFromChrome } from "./chat-composer-dom.ts";
import { ChatEffortPicker } from "./chat-effort-picker.tsx";
import { installChatComposerPickerDismissal } from "./chat-picker-overlay.ts";

let host: HTMLDivElement | undefined;
let updatePicker: ((props: Parameters<typeof ChatEffortPicker>[0]) => void) | undefined;
const speed = (value: string) =>
  host!.querySelector<HTMLButtonElement>(`[data-chat-speed-option="${value}"]`)!;
const summary = () => host!.querySelector("summary")!;
const noBoost = { fill: "none", glow: "none" };

function speedState(
  mode: boolean | "ultrafast",
  tiers?: string[],
  supportsFastMode = true,
  inherited = false,
) {
  return resolveChatFastModeSelectState({
    connected: true,
    gatewayAvailable: true,
    loading: false,
    sessionsResult: null,
    currentModelOverride: "openai/model",
    fastModeTarget: {
      model: "model",
      modelProvider: "openai",
      ...(inherited ? { effectiveFastMode: mode } : { fastMode: mode }),
    },
    catalog: [
      {
        id: "model",
        name: "Model",
        provider: "openai",
        available: true,
        supportsFastMode,
        ...(!inherited && { supportsServiceTierRecovery: true }),
        serviceTiers: tiers,
      },
    ],
  });
}

const speedFixture = (state: ChatFastModeSelectState) =>
  fixture(["low", "medium", "high"], "high", false, state);

afterEach(() => {
  if (host) {
    updatePicker = undefined;
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
  open = true,
) {
  host ??= document.body.appendChild(document.createElement("div"));
  const onThinkingSelect = vi.fn(async () => undefined);
  const onFastModeSelect = vi.fn(async () => undefined);
  const next: Parameters<typeof ChatEffortPicker>[0] = {
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
      persistedOverride: "",
      disabled: true,
      label: "Off",
      nextValue: "on",
      supported: false,
    },
    onFastModeSelect,
    onThinkingSelect,
  };
  if (updatePicker) {
    updatePicker(next);
  } else {
    mountSolid(
      () => {
        const [props, setProps] = createSignal(next);
        updatePicker = (nextProps) => setProps(() => nextProps);
        return <ChatEffortPicker {...props()} />;
      },
      { container: host },
    );
  }
  flush();
  const details = host.querySelector("details")!;
  if (open && !details.open) {
    const opened = new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
    });
    details.open = true;
    // The details toggle commits its native top-layer surface.
    await opened;
  }
  expect(host.querySelector("[data-anchored-overlay]")!.matches(":popover-open")).toBe(open);
  await expect
    .poll(
      () => host?.querySelector<HTMLInputElement>("input[type=range]")?.checkVisibility() ?? false,
    )
    .toBe(open);
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
  it("returns Escape to its trigger after pointer and keyboard reopening with title tooltips", async () => {
    await fixture(["low", "medium", "high"], "high", false, undefined, false);
    const composer = host!;
    composer.classList.add("agent-chat__input");
    const details = composer.querySelector("details")!;
    const trigger = details.querySelector("summary")!;
    const surface = details.querySelector<HTMLElement>("[data-anchored-overlay]")!;
    const inputWrapper = document.createElement("div");
    inputWrapper.className = "agent-chat__composer-combobox";
    const textarea = document.createElement("textarea");
    inputWrapper.append(textarea);
    composer.prepend(inputWrapper);
    onTestFinished(installChatComposerPickerDismissal(document));
    onTestFinished(installTitleTooltips(document));
    const focusComposer = (event: MouseEvent | PointerEvent) =>
      focusComposerFromChrome(event, true, textarea);
    composer.addEventListener("pointerdown", focusComposer);
    composer.addEventListener("click", focusComposer);
    onTestFinished(() => {
      composer.removeEventListener("pointerdown", focusComposer);
      composer.removeEventListener("click", focusComposer);
    });
    textarea.focus();
    await page.elementLocator(trigger).click();
    await expect.poll(() => surface.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(textarea);
    await expect
      .poll(() => surface.getAnimations().every((animation) => animation.playState === "finished"))
      .toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => details.open).toBe(false);
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => surface.matches(":popover-open")).toBe(true);
    await userEvent.keyboard("{Tab}");
    await expect.poll(() => document.activeElement).toBe(host!.querySelector("input[type=range]"));
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => details.open).toBe(false);
    await expect.poll(() => surface.matches(":popover-open")).toBe(false);
    await expect.poll(() => document.activeElement).toBe(trigger);
  });

  it("keeps inherited speed selectable, accessible, and limited to entitled choices", async () => {
    await speedFixture(speedState(false));
    expect(summary().textContent?.trim()).toBe("High");
    expect(host!.querySelectorAll("[data-chat-speed-option]")).toHaveLength(2);
    const { onFastModeSelect } = await speedFixture(
      speedState("ultrafast", ["priority", "ultrafast"], true, true),
    );
    expect(summary().textContent?.trim()).toBe("High");
    expect(summary().getAttribute("aria-label")).toContain("High · Ultrafast");
    expect(summary().title).toBe("High · Ultrafast");
    expect(
      [...host!.querySelectorAll("[data-chat-speed-option]")].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Standard", "Fast", "Ultrafast"]);
    const ultra = speed("ultrafast");
    expect(ultra.getAttribute("aria-checked")).toBe("true");
    for (const value of ["off", "on", "ultrafast"]) {
      expect(speed(value).disabled).toBe(false);
      speed(value).click();
      expect(onFastModeSelect).toHaveBeenLastCalledWith(value, "effort-preview");
    }
    ultra.focus();
    ultra.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(onFastModeSelect).toHaveBeenLastCalledWith("on", "effort-preview");
    await speedFixture(speedState("ultrafast", ["priority", "ultrafast"], false));
    expect(speed("ultrafast").disabled).toBe(true);
    expect(speed("on")).toBeNull();
    const standardOnly = await speedFixture(speedState("ultrafast", ["default"], false));
    expect(speed("off").getAttribute("aria-checked")).toBe("true");
    for (const option of host!.querySelectorAll<HTMLButtonElement>("[data-chat-speed-option]")) {
      expect(option.disabled).toBe(true);
      option.click();
    }
    expect(standardOnly.onFastModeSelect).not.toHaveBeenCalled();
    expect(standardOnly.input.disabled).toBe(false);
    expect(host!.querySelector(".chat-controls__effort-zap")).toBeNull();
    await speedFixture(speedState("ultrafast"));
    expect(speed("ultrafast").disabled).toBe(true);
    expect(summary().getAttribute("aria-label")).toContain("Ultrafast");
    expect(speed("ultrafast").getAttribute("aria-checked")).toBe("true");
    expect(speed("off").getAttribute("tabindex")).toBe("0");
    expect(speed("ultrafast").getAttribute("tabindex")).toBe("-1");
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
        expect(appearance((await fixture(levels, value)).input)).toEqual(noBoost);
      }
    }
    expect(appearance((await fixture(["off", "on"], "on")).input)).toEqual(noBoost);
    for (const id of ["low", "high"]) {
      const { input } = await fixture(["off", { id, label: "on" }, "ultra"], id);
      expect(appearance(input)).toEqual(noBoost);
    }
  });

  it("previews colour without committing and restores the committed level on cancel or blur", async () => {
    const { input, onThinkingSelect } = await fixture(["low", "max", "ultra"], "max", true);
    const maximumStyle = appearance(input);
    for (const resetEvent of ["pointercancel", "blur"]) {
      input.value = "2";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(input.getAttribute("aria-valuetext")).toBe("Ultra");
      expect(appearance(input)).not.toEqual(maximumStyle);
      expect(onThinkingSelect).not.toHaveBeenCalled();
      input.dispatchEvent(new Event(resetEvent));
      flush();
      expect(input.value).toBe("1");
      expect(input.getAttribute("aria-valuetext")).toContain("Maximum");
      expect(appearance(input)).toEqual(maximumStyle);
    }
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(appearance(input)).toEqual(noBoost);
    input.dispatchEvent(new Event("change"));
    flush();
    expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("low", "effort-preview");
    expect(appearance(input)).toEqual(maximumStyle);
  });
});
