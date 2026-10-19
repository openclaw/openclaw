/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import type { PickerFocusHandle } from "./select-picker-types.ts";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { Picker } from "./solid/select-picker.tsx";

it.each([false, true])(
  "places initial focus without overriding a chosen control (%s)",
  async (chosen) => {
    const container = document.createElement("div");
    const anchor = document.createElement("button");
    document.body.append(container);
    container.append(anchor);
    let input!: HTMLInputElement;
    let button!: HTMLButtonElement;
    onTestFinished(() => container.remove());
    if (chosen) {
      container.addEventListener(
        "toggle",
        () => {
          container
            .querySelector<HTMLButtonElement>(".sidebar-session-filter-panel button")
            ?.focus();
        },
        { once: true, capture: true },
      );
    }
    mountSolid(
      () => (
        <SidebarSessionFilterPopover
          anchor={anchor}
          label="Filter sessions"
          initialFocus={() => input}
          focusTargets={() => [input, button]}
          onClose={() => {}}
          content={
            <>
              <div id="sidebar-sessions-status">
                <input ref={(element) => (input = element)} type="radio" checked />
              </div>
              <button ref={(element) => (button = element)}>Sort</button>
            </>
          }
        />
      ),
      { container },
    );
    await waitForSolid(() => expect(container.querySelector("input")).not.toBeNull());
    const initial = container.querySelector("input")!;
    const control = container.querySelector<HTMLButtonElement>(
      "openclaw-sidebar-session-filter-popover button",
    )!;
    await waitForSolid(() => expect(document.activeElement).toBe(chosen ? control : initial));
    control.focus();
    container
      .querySelector(".sidebar-session-filter-panel")!
      .dispatchEvent(new CustomEvent("overlay-after-show"));
    expect(document.activeElement).toBe(control);
  },
);

it("wraps focus from a nested picker's final group control", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  const container = document.createElement("div");
  const anchor = document.createElement("button");
  document.body.append(container);
  container.append(anchor);
  onTestFinished(() => container.remove());
  let picker: PickerFocusHandle | undefined;
  mountSolid(
    () => (
      <SidebarSessionFilterPopover
        anchor={anchor}
        label="Filter sessions"
        initialFocus={() => picker?.trigger}
        focusTargets={() => picker?.elements() ?? []}
        onClose={() => {}}
        content={
          <Picker
            label="Status"
            value="one"
            sheet
            searchable="always"
            groupBy={(option) => ({ id: option.value, label: option.label })}
            focusRef={(handle) => (picker = handle)}
            options={[
              { value: "one", label: "One" },
              { value: "two", label: "Two" },
            ]}
            onChange={() => {}}
          />
        }
      />
    ),
    { container },
  );
  await waitForSolid(() => expect(document.activeElement).toBe(picker?.trigger));
  picker!.trigger.click();
  await waitForSolid(() =>
    expect(container.querySelectorAll(".picker-select__group-toggle")).toHaveLength(2),
  );
  const last = [...container.querySelectorAll<HTMLElement>(".picker-select__group-toggle")].at(-1)!;
  last.focus();
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  last.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(picker!.trigger);
});
