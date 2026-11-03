/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  ChatContextWindowControl,
  type ChatContextWindowControlParams,
} from "./chat-context-window-control.tsx";

it("keeps multi-option context selection contained and ignores current or disabled choices", () => {
  const onSelect = vi.fn(async (_next: string, _sessionKey: string) => {});
  const bubbled = vi.fn();
  const [props, setProps] = createSignal<ChatContextWindowControlParams>({
    options: [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "500k", label: "500K", contextWindow: 500_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ],
    selected: "1m",
    disabled: false,
    onSelect,
  });
  const view = mountSolid(() => (
    <ChatContextWindowControl contextWindow={props()} sessionKey="agent:main:synthetic" />
  ));
  const host = view.container;
  host.addEventListener("click", bubbled);
  const click = (label: string) => {
    const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    );
    if (!button) {
      throw new Error(`Missing context option ${label}`);
    }
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    return event;
  };
  try {
    expect(host.querySelector('[aria-pressed="true"]')?.textContent?.trim()).toBe("1M");
    expect(click("1M").defaultPrevented).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    click("200K");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("200k", "agent:main:synthetic");
    setProps({ ...props(), disabled: true });
    flush();
    expect(
      [...host.querySelectorAll<HTMLButtonElement>("button")].every((button) => button.disabled),
    ).toBe(true);
    expect(click("500K").defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(bubbled).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("toggles between context sizes in numeric order and follows updated selection", () => {
  const onSelect = vi.fn(async (_next: string, _sessionKey: string) => {});
  const [props, setProps] = createSignal<ChatContextWindowControlParams>({
    options: [
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
      { id: "200k", label: "200K", contextWindow: 200_000 },
    ],
    selected: "200k",
    disabled: false,
    onSelect,
  });
  const view = mountSolid(() => (
    <ChatContextWindowControl contextWindow={props()} sessionKey="agent:main:synthetic" />
  ));
  const bubbled = vi.fn();
  view.container.addEventListener("click", bubbled);
  const toggle = () => view.getByRole("switch");
  try {
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    toggle().click();
    expect(onSelect).toHaveBeenLastCalledWith("1m", "agent:main:synthetic");
    setProps({ ...props(), selected: "1m" });
    flush();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    toggle().click();
    expect(onSelect).toHaveBeenLastCalledWith("200k", "agent:main:synthetic");
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(bubbled).not.toHaveBeenCalled();
    setProps({ ...props(), selected: "unavailable" });
    flush();
    expect(view.queryByRole("switch")).toBeNull();
    expect(view.container.textContent).toBe("");
  } finally {
    view.unmount();
  }
});
