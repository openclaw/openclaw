/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { useSessionMenuAppearance } from "./session-icon-picker-solid.tsx";

it("keeps custom icon entry focused and ignores Enter while an IME composition is active", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const runAction = vi.fn();
  const mounted = mountSolid(
    () => {
      const appearance = useSessionMenuAppearance(
        () => ({ session: { icon: null, color: null }, actionDisabledReasons: {} }),
        () => false,
        runAction,
      );
      return appearance.render();
    },
    { container: host },
  );
  const custom = mounted.container.querySelector<HTMLButtonElement>(
    ".session-menu__icon-choice--custom",
  )!;
  custom.click();
  flush();
  const input = mounted.container.querySelector<HTMLTextAreaElement>(
    ".session-menu__icon-custom-input",
  )!;
  expect(document.activeElement).toBe(input);
  input.value = "🦀";
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
  );
  expect(runAction).not.toHaveBeenCalled();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(runAction).toHaveBeenCalledExactlyOnceWith({ kind: "set-icon", icon: "🦀" });
  mounted.container.querySelector<HTMLButtonElement>(".session-menu__icon-back")!.click();
  flush();
  expect(document.activeElement).toBe(custom);
  expect(custom.tabIndex).toBe(0);
  expect(
    [...host.querySelectorAll(".session-menu__icon-choice")].filter(
      (choice) => choice.getAttribute("tabindex") === "0",
    ),
  ).toEqual([custom]);
  expect(input.value).toBe("");
  mounted.unmount();
  host.remove();
});

it("moves the icon grid tab stop and sends appearance actions through the menu owner", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const runAction = vi.fn();
  const mounted = mountSolid(
    () =>
      useSessionMenuAppearance(
        () => ({ session: { icon: "🦞", color: null }, actionDisabledReasons: {} }),
        () => false,
        runAction,
      ).render(),
    { container: host },
  );
  const choices = mounted.container.querySelectorAll<HTMLButtonElement>(
    ".session-menu__icon-choice",
  );
  // The emoji row's clear choice stays reachable although the icon row repeats it.
  choices[1]!.focus();
  choices[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  expect(document.activeElement).toBe(choices[0]);
  expect(choices[0]!.getAttribute("aria-label")).toBe("No icon");
  choices[1]!.focus();
  choices[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(document.activeElement).toBe(choices[2]);
  expect(choices[1]!.tabIndex).toBe(-1);
  expect(choices[2]!.tabIndex).toBe(0);
  choices[2]!.click();
  expect(runAction).toHaveBeenLastCalledWith({ kind: "set-icon", icon: "🚀" });
  mounted.container.querySelector<HTMLButtonElement>(".session-menu__icon-remove")!.click();
  expect(runAction).toHaveBeenLastCalledWith({ kind: "reset-appearance" });
  mounted.unmount();
  host.remove();
});

it("leads the emoji and icon grids with the clear choice and keeps one tab stop", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const runAction = vi.fn();
  const mounted = mountSolid(
    () =>
      useSessionMenuAppearance(
        () => ({ session: { icon: null, color: null }, actionDisabledReasons: {} }),
        () => false,
        runAction,
      ).render(),
    { container: host },
  );
  const noIcon = [
    ...host.querySelectorAll<HTMLButtonElement>(".session-menu__icon-grid > :first-child"),
  ];
  expect(noIcon.map((choice) => choice.getAttribute("aria-label"))).toEqual(["No icon", "No icon"]);
  expect(noIcon.map((choice) => [choice.getAttribute("aria-pressed"), choice.tabIndex])).toEqual([
    ["true", 0],
    ["true", -1],
  ]);
  noIcon[0]!.click();
  expect(runAction).toHaveBeenLastCalledWith({ kind: "set-icon", icon: null });
  mounted.unmount();
  host.remove();
});
