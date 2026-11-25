/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  ChatContextWindowControl,
  type ChatContextWindowControlParams,
} from "./chat-context-window-control.tsx";

it("selects context sizes in numeric order and follows updated selection", () => {
  const onSelect = vi.fn(async (_next: string, _sessionKey: string) => {});
  const [props, setProps] = createSignal<ChatContextWindowControlParams>({
    options: [
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
      { id: "272k", label: "272K", contextWindow: 272_000 },
    ],
    selected: "272k",
    disabled: false,
    onSelect,
  });
  const view = mountSolid(() => (
    <ChatContextWindowControl contextWindow={props()} sessionKey="agent:main:synthetic" />
  ));
  const trigger = () => view.getByRole("button", { name: /^Context window:/ });
  const choices = () => [
    ...view.container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
  ];
  try {
    expect(trigger().textContent).toBe("272K");
    expect(choices().map((button) => button.textContent)).toEqual(["272K", "1M"]);
    trigger().click();
    flush();
    choices()[0]!.click();
    flush();
    expect(onSelect).not.toHaveBeenCalled();
    trigger().click();
    flush();
    choices()[1]!.click();
    flush();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("1m", "agent:main:synthetic");
    setProps((current) => ({ ...current, selected: "1m", disabled: true }));
    flush();
    expect(trigger().textContent).toBe("1M");
    expect(trigger().hasAttribute("disabled")).toBe(true);
    expect(choices()[1]!.getAttribute("aria-checked")).toBe("true");
    choices()[0]!.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    setProps((current) => ({ ...current, selected: "unavailable" }));
    flush();
    expect(view.container.textContent).toBe("");
  } finally {
    view.unmount();
  }
});
