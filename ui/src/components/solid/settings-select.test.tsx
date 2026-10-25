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
    const firstOption = { value: "one", label: "One" };
    const options = [firstOption, { value: "two", label: "Two", disabled: true }];
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
    const retained = select.options.item(1)!;
    expect(retained.disabled).toBe(true);

    view.update({
      "aria-label": "Target",
      value: "two",
      options: [firstOption, { value: "two", label: "Renamed" }],
      onChange: second,
    });
    expect(view.container.querySelector("select")).toBe(select);
    expect(select.options[1]).toBe(retained);
    expect(retained.textContent).toBe("Renamed");
    expect(retained.disabled).toBe(false);
    expect(select.value).toBe("two");
    select.value = "one";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
