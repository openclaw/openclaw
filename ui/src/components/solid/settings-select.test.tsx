// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { SettingsSelect } from "./settings-select.tsx";

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

describe("SettingsSelect", () => {
  it("retains the native control while options, selection, and handlers change", () => {
    const first = vi.fn();
    const second = vi.fn();
    const options = [
      { value: "one", label: "One" },
      { value: "two", label: "Two", disabled: true },
    ];
    const view = mountSolid(SettingsSelect, {
      "aria-label": "Target",
      value: "one",
      options,
      onChange: first,
    });
    cleanup = () => {
      view.dispose();
      view.container.remove();
    };
    const select = view.container.querySelector("select")!;
    expect(select.className).toBe("settings-select");
    expect(select.getAttribute("aria-label")).toBe("Target");
    expect(select.value).toBe("one");
    expect(select.options[1].disabled).toBe(true);
    const retained = select.options[1];

    view.update({
      "aria-label": "Target",
      value: "two",
      options: [options[0], { value: "two", label: "Renamed" }],
      onChange: second,
    });
    expect(view.container.querySelector("select")).toBe(select);
    expect(select.options[1]).toBe(retained);
    expect(select.options[1].textContent).toBe("Renamed");
    expect(select.options[1].disabled).toBe(false);
    expect(select.value).toBe("two");
    select.value = "one";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
