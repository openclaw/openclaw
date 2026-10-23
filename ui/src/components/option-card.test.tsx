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
function expectRows(view: ReturnType<typeof mount>, rows: HTMLElement[]) {
  view.getAllByRole("radio").forEach((row, index) => expect(row).toBe(rows[index]));
  expect(view.getAllByRole("radio")).toHaveLength(rows.length);
}

describe("option card", () => {
  it("accents and focuses the recommended choice, then calls its selection handler", () => {
    const onSelect = vi.fn();
    const { container } = mount({
      header: "Access",
      options: choices(true, "Use announced defaults").toReversed(),
      onSelect,
    });
    const recommended = container.querySelector<HTMLButtonElement>(
      ".option-card__choice--recommended",
    )!;

    expect(recommended.getAttribute("aria-checked")).toBe("true");
    expect(recommended.textContent).toContain("Recommended");
    expect(document.activeElement).toBe(recommended);
    recommended.click();

    expect(onSelect).toHaveBeenCalledWith("one");
  });

  it.each(["textarea", "button"] as const)(
    "preserves focus on a %s without retrying a refused recommendation",
    (tagName) => {
      const control = document.createElement(tagName);
      const target = document.createElement("div");
      const { container } = mountSolid(() => <div />);
      container.append(control, target);
      control.focus();
      const view = mount({ options: choices(true), disabled: false }, target);

      expect(document.activeElement).toBe(control);
      control.blur();
      view.update({ disabled: true });
      view.update({ disabled: false, options: choices(true, "Updated details") });

      expect(document.activeElement).toBe(document.body);
      control.remove();
    },
  );

  it("holds a disabled recommendation and retains selection and rows across display updates", () => {
    const onSelect = vi.fn();
    const view = mount({
      options: choices(true),
      disabled: true,
      onSelect,
    });
    const recommended = view.getByRole("radio", { name: "OneRecommended" });
    const second = view.getByRole("radio", { name: "Two" });
    expect(document.activeElement).toBe(document.body);

    view.update({ options: choices(true, "Updated details") });
    expectRows(view, [recommended, second]);
    expect(document.activeElement).toBe(document.body);

    view.update({ disabled: false });
    expect(document.activeElement).toBe(recommended);
    second.focus();
    second.click();
    flush();
    expect(second.getAttribute("aria-checked")).toBe("true");

    view.update({ disabled: true });
    second.click();
    expect(second.getAttribute("aria-checked")).toBe("true");
    expect(second.hasAttribute("disabled")).toBe(true);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("two");

    view.update({ disabled: false, options: choices(true, "More details") });
    expectRows(view, [recommended, second]);
    expect(second.getAttribute("aria-checked")).toBe("true");

    view.update({ question: "Next question", disabled: false });
    expect(recommended.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(recommended);
  });

  it("cancels a disabled recommendation when the next request has none", () => {
    const view = mount({
      options: [{ value: "one", label: "One", recommended: true }],
      disabled: true,
    });
    view.update({
      question: "Choose freely",
      options: [{ value: "one", label: "One", recommended: false }],
    });
    view.update({ disabled: false });

    expect(view.getByRole("radio").getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(document.body);
  });

  it("keeps the choices to one Tab stop and moves the checked choice with arrow keys", () => {
    const onSelect = vi.fn();
    const previous = document.createElement("button");
    const target = document.createElement("div");
    const { container } = mountSolid(() => <div />);
    container.append(previous, target);
    const view = mount(
      {
        options: [...choices(), { value: "three", label: "Three" }],
        onSelect,
      },
      target,
    );
    const [one, two, three] = view.getAllByRole("radio");
    const skip = view.getByRole("button", { name: "Skip for now" });
    const tabStops = () =>
      [...container.querySelectorAll("button")].filter((button) => button.tabIndex >= 0);
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
    expect(two!.getAttribute("aria-checked")).toBe("true");
    expect(one!.getAttribute("aria-checked")).toBe("false");
    expect(tabStops()).toEqual([previous, two, skip]);

    const walk = ["ArrowRight", "ArrowDown", "ArrowUp", "ArrowLeft", "End", "Home"].map((key) => {
      press(key);
      return view.getAllByRole("radio").indexOf(document.activeElement as HTMLElement);
    });
    expect(walk).toEqual([2, 0, 2, 1, 2, 0]);
    expect(one!.getAttribute("aria-checked")).toBe("true");
    expect(tabStops()).toEqual([previous, one, skip]);
    expect(onSelect).not.toHaveBeenCalled();

    three!.click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("three");
  });
});
