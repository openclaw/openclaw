/* @vitest-environment jsdom */
import type { JSX } from "@solidjs/web";
import { expect, it, onTestFinished, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { PickerFocusHandle } from "./select-picker-types.ts";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { Picker } from "./solid/select-picker.tsx";

function mountFilter(
  content: () => JSX.Element,
  focusTargets: () => readonly HTMLElement[],
  chooseControl?: () => void,
) {
  const container = document.body.appendChild(document.createElement("div"));
  const anchor = container.appendChild(document.createElement("button"));
  onTestFinished(() => container.remove());
  if (chooseControl) {
    container.addEventListener("toggle", chooseControl, { once: true, capture: true });
  }
  mountSolid(
    () => (
      <SidebarSessionFilterPopover
        anchor={anchor}
        focusTargets={focusTargets}
        initialFocus={() => focusTargets()[0]}
        label="Filter sessions"
        onClose={() => {}}
        content={content()}
      />
    ),
    { container },
  );
  return container;
}

it.each([false, true])("preserves initial or chosen focus (%s)", async (chosen) => {
  let input!: HTMLInputElement;
  let button!: HTMLButtonElement;
  const container = mountFilter(
    () => (
      <>
        <input ref={(element) => (input = element)} type="radio" checked />
        <button ref={(element) => (button = element)}>Sort</button>
      </>
    ),
    () => [input, button],
    chosen ? () => button?.focus() : undefined,
  );
  await waitForSolid(() => expect(document.activeElement).toBe(chosen ? button : input));
  button.focus();
  const panel = container.querySelector(".sidebar-session-filter-panel")!;
  panel.dispatchEvent(new CustomEvent("overlay-after-show"));
  expect(document.activeElement).toBe(button);
});

it("wraps focus from a nested picker's final group control", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  let picker: PickerFocusHandle | undefined;
  const container = mountFilter(
    () => (
      <Picker
        label="Status"
        value="one"
        sheet
        searchable="always"
        groupBy={(option) => ({ id: option.value, label: option.label })}
        focusRef={(handle) => (picker = handle)}
        options={["one", "two"].map((value) => ({ value, label: value }))}
        onChange={() => {}}
      />
    ),
    () => picker?.elements() ?? [],
  );
  await waitForSolid(() => expect(document.activeElement).toBe(picker?.trigger));
  picker!.trigger.click();
  const groups = () => [...container.querySelectorAll<HTMLElement>(".picker-select__group-toggle")];
  await waitForSolid(() => expect(groups()).toHaveLength(2));
  const last = groups().at(-1)!;
  last.focus();
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  last.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(picker!.trigger);
});
