import { createSignal } from "solid-js";
import { afterEach, assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import {
  resolveChatFastModeSelectState,
  type ChatFastModeSelectState,
} from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { emulateOverlayMedia } from "../../../test-helpers/overlay-browser-media.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import type { ChatAccessProgramControlProps } from "./chat-access-program-control.tsx";
import { focusComposerFromChrome } from "./chat-composer-dom.ts";
import { ChatEffortPicker } from "./chat-effort-picker.tsx";
import { installChatComposerPickerDismissal } from "./chat-picker-overlay.ts";

let host: HTMLDivElement | undefined;
let updatePicker: ((props: Parameters<typeof ChatEffortPicker>[0]) => void) | undefined;
const speed = (value: string) =>
  host!.querySelector<HTMLButtonElement>(`[data-chat-speed-option="${value}"]`)!;
const summary = () => host!.querySelector("summary")!;

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
  accessProgram?: Parameters<typeof ChatEffortPicker>[0]["accessProgram"],
) {
  host ??= document.body.appendChild(document.createElement("div"));
  const onThinkingSelect = vi.fn(async () => undefined);
  const onFastModeSelect = vi.fn(async () => undefined);
  const next: Parameters<typeof ChatEffortPicker>[0] = {
    accessProgram,
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
    .toBe(open && levels.length > 1);
  return {
    input: host.querySelector<HTMLInputElement>("input[type=range]")!,
    onThinkingSelect,
    onFastModeSelect,
  };
}

describe("effort selection", () => {
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
    // macOS WebKit uses Option-Tab to traverse controls inside the open picker.
    await userEvent.keyboard(
      navigator.platform.includes("Mac") &&
        navigator.userAgent.includes("AppleWebKit") &&
        !navigator.userAgent.includes("Chrome")
        ? "{Alt>}{Tab}{/Alt}"
        : "{Tab}",
    );
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
    expect(host!.querySelector(".chat-controls__effort-zap")!.checkVisibility()).toBe(true);
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
    await speedFixture(speedState(true, undefined, false, true));
    expect(summary().getAttribute("data-chat-fast-mode")).toBe("false");
    expect(host!.querySelector(".chat-controls__effort-zap")).toBeNull();
    expect(host!.querySelector(".chat-controls__effort-fast-badge")).toBeNull();
    expect(host!.querySelector(".chat-controls__effort-gauge-needle")).not.toBeNull();
    expect(summary().title).toBe("High");
    await speedFixture(speedState("ultrafast"));
    expect(speed("ultrafast").disabled).toBe(true);
    expect(summary().getAttribute("aria-label")).toContain("Ultrafast");
    expect(speed("ultrafast").getAttribute("aria-checked")).toBe("true");
    expect(speed("off").getAttribute("tabindex")).toBe("0");
    expect(speed("ultrafast").getAttribute("tabindex")).toBe("-1");
  });

  it("previews effort without committing and restores the committed level on cancel or blur", async () => {
    const { input, onThinkingSelect } = await fixture(["low", "max", "ultra"], "max", true);
    for (const resetEvent of ["pointercancel", "blur"]) {
      input.value = "1.72";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(input.value).toBe("1.72");
      expect(input.getAttribute("aria-valuetext")).toBe("Ultra");
      expect(summary().textContent?.trim()).toBe("Maximum");
      expect(onThinkingSelect).not.toHaveBeenCalled();
      input.dispatchEvent(new Event(resetEvent));
      flush();
      expect(input.value).toBe("1");
      expect(input.getAttribute("aria-valuetext")).toContain("Maximum");
    }
    input.value = "0.28";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(input.getAttribute("aria-valuetext")).toBe("Low");
    input.dispatchEvent(new Event("change"));
    flush();
    expect(input.value).toBe("0");
    expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("low", "effort-preview");
    expect(input.getAttribute("aria-valuetext")).toContain("Maximum");

    const unanchored = await fixture(["low", "ultra"], "off");
    unanchored.input.dispatchEvent(new PointerEvent("pointerdown"));
    unanchored.input.value = "0.2";
    unanchored.input.dispatchEvent(new Event("input", { bubbles: true }));
    unanchored.input.dispatchEvent(new Event("change"));
    unanchored.input.dispatchEvent(new MouseEvent("click"));
    expect(unanchored.onThinkingSelect).toHaveBeenCalledExactlyOnceWith("low", "effort-preview");
  });
});

it("maps actual supported stops and handles a single available effort", async () => {
  for (const [level, index] of [
    ["low", 0],
    ["medium", 1],
    ["high", 2],
  ] as const) {
    const { input } = await fixture(["low", "medium", "high"], level);
    expect(input.value).toBe(String(index));
    expect(input.getAttribute("aria-valuetext")?.toLowerCase()).toBe(level);
  }
  for (const minimum of ["low", "medium", "high"]) {
    const { input } = await fixture([minimum, "ultra"], minimum);
    expect(input.value).toBe("0");
    expect(input.getAttribute("aria-valuetext")?.toLowerCase()).toBe(minimum);
  }
  const { input } = await fixture(["medium", "ultra"], "ultra");
  expect(input.value).toBe("1");
  expect(input.getAttribute("aria-valuetext")).toBe("Ultra");
  await fixture(["medium"], "medium");
  expect(host!.querySelector("input[type=range]")).toBeNull();
  expect(
    host!.querySelector('[data-chat-thinking-option="medium"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
});

it("plays Ultra feedback only when entering Ultra, including an uncommitted drag", async () => {
  const { input, onThinkingSelect } = await fixture(["low", "high", "ultra"], "ultra");
  const feedback = () => host!.querySelector(".chat-controls__reasoning-glow")!.getAnimations()[0];
  expect(feedback()).toBeUndefined();
  const preview = (value: string) => {
    const currentInput = host!.querySelector<HTMLInputElement>("input[type=range]")!;
    currentInput.value = value;
    currentInput.dispatchEvent(new Event("input", { bubbles: true }));
  };
  preview("1");
  expect(feedback()).toBeUndefined();
  input.dispatchEvent(new PointerEvent("pointermove", { buttons: 1 }));
  preview("2");
  const first = feedback();
  assert.isDefined(first);
  expect(onThinkingSelect).not.toHaveBeenCalled();
  preview("2");
  expect(feedback()).toBe(first);
  first.pause();
  first.currentTime = 150;
  preview("1");
  expect(first.playState).toBe("idle");
  const fading = feedback();
  assert.isDefined(fading);
  expect(fading).not.toBe(first);
  preview("2");
  expect(fading.playState).toBe("idle");
  expect(feedback()).not.toBe(first);
  input.dispatchEvent(new Event("pointercancel"));
  expect(feedback()).toBeUndefined();
  expect(summary().textContent?.trim()).toBe("Ultra");
  await fixture(["low", "medium", "high"], "medium");
  preview("2");
  expect(feedback()).toBeUndefined();
  await emulateOverlayMedia({ reducedMotion: "reduce" });
  onTestFinished(() => emulateOverlayMedia({ reducedMotion: "no-preference" }));
  await expect.poll(() => matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  // WebKit delivers changes to existing MediaQueryLists after the emulation response.
  await expect
    .poll(() => host!.querySelector(".chat-controls__effort-value")!.getAnimations().length)
    .toBe(0);
  await fixture(["low", "high", "ultra"], "high");
  preview("2");
  expect(feedback()).toBeUndefined();
  expect(host!.querySelector(".chat-controls__effort-value")!.getAnimations()).toHaveLength(0);
});

it("keeps keyboard changes on real effort levels when pointer input is continuous", async () => {
  const levels = ["low", "high", "ultra"];
  let committed = "high";
  for (const { key, expected } of [
    { key: "ArrowRight", expected: "ultra" },
    { key: "ArrowLeft", expected: "high" },
    { key: "Home", expected: "low" },
    { key: "End", expected: "ultra" },
  ]) {
    const { input, onThinkingSelect } = await fixture(levels, committed);
    input.focus();
    await userEvent.keyboard(`{${key}}`);
    expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith(expected, "effort-preview");
    expect(input.value).toBe(String(levels.indexOf(expected)));
    committed = expected;
  }
});

it("restores the remembered permitted Daybreak choice and recovers an unavailable selection", async () => {
  const onSelect = vi.fn();
  const access = {
    sessionKey: "effort-preview",
    disabled: false,
    programs: ["standard", "daybreak_blue", "daybreak_red"] as const,
    onSelect,
  };
  const draw = (extra: Partial<ChatAccessProgramControlProps>) =>
    fixture(["low", "high"], "low", false, undefined, true, { ...access, ...extra });
  const toggle = () => host!.querySelector<HTMLInputElement>(".chat-controls__access-head input")!;
  const option = (value: string) =>
    host!.querySelector<HTMLButtonElement>(`[data-chat-access-option="${value}"]`)!;
  await draw({ requested: "standard", previous: "daybreak_red" });
  await userEvent.click(toggle());
  expect(onSelect).toHaveBeenLastCalledWith("daybreak_red", "effort-preview");
  await draw({ requested: "daybreak_red" });
  expect(option("daybreak_red").getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(toggle());
  expect(onSelect).toHaveBeenLastCalledWith("standard", "effort-preview", "daybreak_red");
  await draw({ requested: "daybreak_red", programs: ["standard", "daybreak_blue"] });
  expect(host!.textContent).toContain("Red (unavailable)");
  await userEvent.click(option("daybreak_blue"));
  expect(onSelect).toHaveBeenLastCalledWith("daybreak_blue", "effort-preview");
  await draw({
    requested: "standard",
    previous: "daybreak_red",
    programs: ["standard", "daybreak_blue"],
  });
  await userEvent.click(toggle());
  expect(onSelect).toHaveBeenLastCalledWith("daybreak_blue", "effort-preview");
  await draw({ requested: "daybreak_red", programs: undefined });
  expect(host!.textContent).not.toContain("unavailable");
  expect(toggle().disabled).toBe(false);
  await userEvent.click(toggle());
  expect(onSelect).toHaveBeenLastCalledWith("standard", "effort-preview", "daybreak_red");
  await draw({ requested: "daybreak_red", disabled: true });
  expect(toggle().disabled).toBe(true);
  expect(option("daybreak_blue").disabled).toBe(true);
});
