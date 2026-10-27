/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import {
  ChatAccessProgramControl,
  type ChatAccessProgramControlProps,
} from "./chat-access-program-control.tsx";

it("preserves a native toggle while an unchanged access snapshot is refreshed", () => {
  const onSelect = vi.fn();
  const [props, setProps] = createSignal<ChatAccessProgramControlProps>({
    programs: ["standard", "daybreak_blue", "daybreak_red"],
    requested: "daybreak_blue",
    disabled: false,
    sessionKey: "main",
    onSelect,
  });
  const view = mountSolid(() => <ChatAccessProgramControl {...props()} />);
  flush();
  const toggle = view.getByRole("switch") as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  toggle.addEventListener(
    "click",
    () => {
      setProps((current) => ({ ...current }));
      flush();
    },
    { capture: true, once: true },
  );
  toggle.click();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("standard", "main", "daybreak_blue");
  setProps((current) => ({ ...current, requested: "standard" }));
  flush();
  expect(toggle.checked).toBe(false);
  toggle.click();
  expect(onSelect).toHaveBeenLastCalledWith("daybreak_blue", "main");
  setProps((current) => ({ ...current, requested: "daybreak_red" }));
  flush();
  expect(toggle.checked).toBe(true);
});
