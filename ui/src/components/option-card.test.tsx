/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { OptionCard } from "./option-card.tsx";

type Props = Parameters<typeof OptionCard>[0]["props"];
const choices = (recommended = false, description?: string) => [
  { value: "one", label: "One", recommended, description },
  { value: "two", label: "Two", description },
];
function mount(props: Partial<Props> = {}, container?: HTMLDivElement) {
  const [current, setCurrent] = createSignal<Props>({
    question: "Choose one",
    options: choices(),
    ...props,
  });
  const view = mountSolid(() => <OptionCard props={current()} />, { container });
  const update = (patch: Partial<Props>) => {
    setCurrent((previous) => ({ ...previous, ...patch }));
    flush();
  };
  flush();
  return { ...view, update };
}
function mountBeside(control: HTMLElement, props: Partial<Props> = {}, focus = false) {
  const { container } = mountSolid(() => <div />);
  const target = document.createElement("div");
  container.append(control, target);
  if (focus) {
    control.focus();
  }
  return { ...mount(props, target), container };
}
const checked = (row: HTMLElement) => row.getAttribute("aria-checked");
function expectRows(view: ReturnType<typeof mount>, rows: HTMLElement[]) {
  view.getAllByRole("radio").forEach((row, index) => expect(row).toBe(rows[index]));
  expect(view.getAllByRole("radio")).toHaveLength(rows.length);
}

describe("option card", () => {
  it("preserves external focus without retrying a refused recommendation", () => {
    const control = document.createElement("textarea");
    const view = mountBeside(control, { options: choices(true), disabled: false }, true);

    expect(document.activeElement).toBe(control);
    control.blur();
    view.update({ disabled: true });
    view.update({ disabled: false, options: choices(true, "Updated details") });

    expect(document.activeElement).toBe(document.body);
    control.remove();
  });

  it("holds a disabled recommendation and retains selection and rows across display updates", () => {
    const onSelect = vi.fn();
    const view = mount({
      header: "Access",
      options: choices(true).toReversed(),
      disabled: true,
      onSelect,
    });
    const recommended = view.getByRole("radio", { name: "OneRecommended" });
    const second = view.getByRole("radio", { name: "Two" });
    expect(recommended.classList.contains("option-card__choice--recommended")).toBe(true);
    expect(checked(recommended)).toBe("true");
    expect(document.activeElement).toBe(document.body);

    view.update({ options: choices(true, "Updated details").toReversed() });
    expectRows(view, [second, recommended]);
    expect(document.activeElement).toBe(document.body);

    view.update({ disabled: false });
    expect(document.activeElement).toBe(recommended);
    second.focus();
    second.click();
    flush();
    expect(checked(second)).toBe("true");

    view.update({ disabled: true });
    second.click();
    expect(checked(second)).toBe("true");
    expect(second.hasAttribute("disabled")).toBe(true);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("two");

    view.update({ disabled: false, options: choices(true, "More details").toReversed() });
    expectRows(view, [second, recommended]);
    expect(checked(second)).toBe("true");

    view.update({ question: "Next question", disabled: false });
    expect(checked(recommended)).toBe("true");
    expect(document.activeElement).toBe(recommended);
    recommended.click();
    expect(onSelect).toHaveBeenLastCalledWith("one");
  });

  it("cancels a disabled recommendation when the next request has none", () => {
    const view = mount({ options: choices(true), disabled: true });
    view.update({ question: "Choose freely", options: choices() });
    view.update({ disabled: false });

    expect(checked(view.getByRole("radio", { name: "One" }))).toBe("false");
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the choices to one Tab stop and moves the checked choice with arrow keys", () => {
    const onSelect = vi.fn();
    const previous = document.createElement("button");
    const view = mountBeside(previous, {
      options: [...choices(), { value: "three", label: "Three" }],
      onSelect,
    });
    const [one, two, three] = view.getAllByRole("radio");
    const skip = view.getByRole("button", { name: "Skip for now" });
    const tabStops = () =>
      [...view.container.querySelectorAll("button")].filter((button) => button.tabIndex >= 0);
    const press = (key: string) => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
      flush();
    };

    expect(tabStops()).toEqual([previous, one, skip]);
    one!.focus();
    press("ArrowDown");
    expect(document.activeElement).toBe(two);
    expect([checked(one!), checked(two!)]).toEqual(["false", "true"]);
    expect(tabStops()).toEqual([previous, two, skip]);

    const walk = ["ArrowRight", "ArrowDown", "ArrowUp", "ArrowLeft", "End", "Home"].map((key) => {
      press(key);
      return view.getAllByRole("radio").indexOf(document.activeElement as HTMLElement);
    });
    expect(walk).toEqual([2, 0, 2, 1, 2, 0]);
    expect(checked(one!)).toBe("true");
    expect(tabStops()).toEqual([previous, one, skip]);
    expect(onSelect).not.toHaveBeenCalled();

    three!.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("three");
  });
});
