import { createSignal } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { installTitleTooltips } from "../../../components/tooltip-title.ts";
import { resolveChatFastModeSelectState } from "../../../lib/chat/model-select-state.ts";
import { resolveChatThinkingSelectState } from "../../../lib/chat/thinking.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { focusComposerFromChrome } from "./chat-composer-dom.ts";
import { ChatEffortPicker } from "./chat-effort-picker.tsx";
import { installChatComposerPickerDismissal } from "./chat-picker-overlay.ts";

type PickerProps = Parameters<typeof ChatEffortPicker>[0];
let host: HTMLDivElement | undefined;
let updatePicker: ((props: PickerProps) => void) | undefined;

afterEach(() => {
  updatePicker = undefined;
  host?.remove();
  host = undefined;
  document.documentElement.removeAttribute("data-theme-mode");
});

const query = <T extends Element = HTMLElement>(selector: string) =>
  host!.querySelector<T>(selector)!;
const speedOptions = () => [
  ...host!.querySelectorAll<HTMLButtonElement>("[data-chat-speed-option]"),
];
const text = (element: Node) => element.textContent?.trim();

async function fixture(
  levels: Array<string | { id: string; label: string }>,
  value: string,
  inherited = false,
  fastMode?: PickerProps["fastMode"],
  open = true,
) {
  host ??= document.body.appendChild(document.createElement("div"));
  const onThinkingSelect = vi.fn(async () => undefined);
  const onFastModeSelect = vi.fn(async () => undefined);
  const next: PickerProps = {
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
    const [props, setProps] = createSignal(next);
    updatePicker = (nextProps) => setProps(() => nextProps);
    mountSolid(() => <ChatEffortPicker {...props()} />, { container: host });
  }
  flush();
  const details = query<HTMLDetailsElement>("details");
  if (open && !details.open) {
    await new Promise<void>((resolve) => {
      details.addEventListener("toggle", () => resolve(), { once: true });
      details.open = true;
    });
  }
  const input = query<HTMLInputElement>("input[type=range]");
  expect(query("[data-anchored-overlay]").matches(":popover-open")).toBe(open);
  expect(input?.checkVisibility() ?? false).toBe(open);
  return { input, onThinkingSelect, onFastModeSelect };
}

const appearance = (input: HTMLInputElement) => ({
  fill: getComputedStyle(input.parentElement!).backgroundImage,
  glow: getComputedStyle(input).boxShadow,
});

const speedOption = (value: string) =>
  query<HTMLButtonElement>(`[data-chat-speed-option="${value}"]`);
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
        supportsServiceTierRecovery: inherited ? undefined : true,
        serviceTiers: tiers,
      },
    ],
  });
}
const unboosted = { fill: "none", glow: "none" };
function preview(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

it("returns Escape to its trigger after pointer and keyboard reopening with title tooltips", async () => {
  const { input } = await fixture(["low", "medium", "high"], "high", false, undefined, false);
  const composer = host!;
  composer.classList.add("agent-chat__input");
  const details = query<HTMLDetailsElement>("details");
  const trigger = query("summary");
  const surface = query("[data-anchored-overlay]");
  composer.insertAdjacentHTML(
    "afterbegin",
    '<div class="agent-chat__composer-combobox"><textarea></textarea></div>',
  );
  const textarea = query<HTMLTextAreaElement>("textarea");
  onTestFinished(installChatComposerPickerDismissal(document));
  onTestFinished(installTitleTooltips(document));
  const focusComposer = (event: MouseEvent) => focusComposerFromChrome(event, true, textarea);
  composer.addEventListener("pointerdown", focusComposer);
  composer.addEventListener("click", focusComposer);
  textarea.focus();
  await page.elementLocator(trigger).click();
  await expect.poll(() => surface.matches(":popover-open")).toBe(true);
  expect(document.activeElement).toBe(textarea);
  await expect
    .poll(() => surface.getAnimations().every((a) => a.playState === "finished"))
    .toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => details.open).toBe(false);
  await userEvent.keyboard("{Enter}");
  await expect.poll(() => surface.matches(":popover-open")).toBe(true);
  await userEvent.keyboard("{Tab}");
  await expect.poll(() => document.activeElement).toBe(input);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => details.open).toBe(false);
  await expect.poll(() => surface.matches(":popover-open")).toBe(false);
  await expect.poll(() => document.activeElement).toBe(trigger);
});

it("keeps inherited speed selectable", async () => {
  const fastMode = speedState("ultrafast", ["default", "priority", "ultrafast"], true, true);
  const { onFastModeSelect } = await fixture(["low", "medium", "high"], "high", false, fastMode);
  for (const value of ["off", "on", "ultrafast"]) {
    const option = speedOption(value);
    expect(option.disabled).toBe(false);
    option.click();
    expect(onFastModeSelect).toHaveBeenLastCalledWith(value, "effort-preview");
  }
});
it("keeps speed names accessible without chip labels and only exposes entitled choices", async () => {
  const showSpeed = (mode: boolean | "ultrafast", tiers?: string[], supported = true) =>
    fixture(["low", "medium", "high"], "high", false, speedState(mode, tiers, supported));
  await showSpeed(false);
  expect(text(query("summary"))).toBe("High");
  expect(speedOptions()).toHaveLength(2);
  expect(host!.textContent).not.toContain("higher usage");
  const { onFastModeSelect } = await showSpeed("ultrafast", ["priority", "ultrafast"]);
  expect(text(query("summary"))).toBe("High");
  expect(query("summary").getAttribute("aria-label")).toContain("High · Ultrafast");
  expect(query("summary").title).toBe("High · Ultrafast");
  expect(speedOptions().map(text)).toEqual(["Standard", "Fast", "Ultrafast"]);
  const ultra = speedOption("ultrafast");
  expect(ultra.getAttribute("aria-checked")).toBe("true");
  ultra.focus();
  ultra.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(onFastModeSelect).toHaveBeenLastCalledWith("on", "effort-preview");
  speedOption("off").click();
  expect(onFastModeSelect).toHaveBeenLastCalledWith("off", "effort-preview");
  await showSpeed("ultrafast", ["priority", "ultrafast"], false);
  expect(speedOption("ultrafast").disabled).toBe(true);
  expect(host!.querySelector('[data-chat-speed-option="on"]')).toBeNull();
  const standardOnly = await showSpeed("ultrafast", ["default"], false);
  expect(speedOption("off").getAttribute("aria-checked")).toBe("true");
  for (const option of speedOptions()) {
    expect(option.disabled).toBe(true);
    option.click();
  }
  expect(standardOnly.onFastModeSelect).not.toHaveBeenCalled();
  expect(standardOnly.input.disabled).toBe(false);
  expect(host!.querySelector(".chat-controls__effort-zap")).toBeNull();
  await showSpeed("ultrafast");
  expect(query("summary").getAttribute("aria-label")).toContain("Ultrafast");
  expect(speedOption("ultrafast").disabled).toBe(true);
  expect(speedOption("ultrafast").getAttribute("aria-checked")).toBe("true");
  expect(speedOption("off").getAttribute("tabindex")).toBe("0");
  expect(speedOption("ultrafast").getAttribute("tabindex")).toBe("-1");
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
      expect(appearance((await fixture(levels, value)).input)).toEqual(unboosted);
    }
  }
  expect(appearance((await fixture(["off", "on"], "on")).input)).toEqual(unboosted);
  for (const id of ["low", "high"]) {
    const { input } = await fixture(["off", { id, label: "on" }, "ultra"], id);
    expect(appearance(input)).toEqual(unboosted);
  }
});

it("previews colour without committing and restores the committed level on cancel or blur", async () => {
  const { input, onThinkingSelect } = await fixture(["low", "max", "ultra"], "max", true);
  const maximumStyle = appearance(input);
  for (const resetEvent of ["pointercancel", "blur"]) {
    preview(input, "2");
    expect(input.getAttribute("aria-valuetext")).toBe("Ultra");
    expect(appearance(input)).not.toEqual(maximumStyle);
    expect(onThinkingSelect).not.toHaveBeenCalled();
    input.dispatchEvent(new Event(resetEvent));
    flush();
    expect(input.value).toBe("1");
    expect(input.getAttribute("aria-valuetext")).toContain("Maximum");
    expect(appearance(input)).toEqual(maximumStyle);
  }
  preview(input, "0");
  expect(appearance(input)).toEqual(unboosted);
  input.dispatchEvent(new Event("change"));
  flush();
  expect(onThinkingSelect).toHaveBeenCalledExactlyOnceWith("low", "effort-preview");
  expect(appearance(input)).toEqual(maximumStyle);
});
