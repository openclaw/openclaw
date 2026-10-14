/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { OptionCard } from "./option-card.tsx";

describe("option card", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("accents and focuses the recommended choice, then emits its value", () => {
    const onSelect = vi.fn();
    const selected = vi.fn();
    container.addEventListener("option-select", selected);
    const props = {
      header: "Access",
      question: "How should OpenClaw help?",
      options: [
        { value: "guarded", label: "Ask first" },
        {
          value: "full",
          label: "Full access",
          description: "Use announced defaults",
          recommended: true,
        },
      ],
      onSelect,
    };
    mountSolid(() => <OptionCard props={props} />, { container });
    flush();
    const recommended = container.querySelector<HTMLButtonElement>(
      ".option-card__choice--recommended",
    )!;

    expect(recommended.getAttribute("aria-checked")).toBe("true");
    expect(recommended.textContent).toContain("Recommended");
    expect(document.activeElement).toBe(recommended);
    recommended.click();

    expect(onSelect).toHaveBeenCalledWith("full");
    expect(selected).toHaveBeenCalledOnce();
    const selectEvent = selected.mock.calls[0]![0] as CustomEvent;
    expect(selectEvent.detail).toEqual({ value: "full" });
  });

  it("always renders a skip affordance and emits dismissal", () => {
    const onSkip = vi.fn();
    const skipped = vi.fn();
    container.addEventListener("option-skip", skipped);
    const props = {
      question: "Choose one",
      options: [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ],
      onSkip,
    };
    mountSolid(() => <OptionCard props={props} />, { container });
    flush();
    container.querySelector<HTMLButtonElement>(".option-card__skip")!.click();

    expect(onSkip).toHaveBeenCalledOnce();
    expect(skipped).toHaveBeenCalledOnce();
  });

  it.each(["textarea", "button"] as const)(
    "preserves focus on a %s when a recommended answer arrives",
    (tagName) => {
      const control = document.createElement(tagName);
      const target = document.createElement("div");
      container.append(control, target);
      control.focus();
      const props = {
        question: "What would you like to do first?",
        options: [
          { value: "chat", label: "Talk to my agent", recommended: true },
          { value: "channels", label: "See all channels" },
        ],
      };
      mountSolid(() => <OptionCard props={props} />, { container: target });
      flush();

      expect(document.activeElement).toBe(control);
    },
  );

  it("retains the selected answer across disabled updates and preselects a new question", () => {
    const onSelect = vi.fn();
    const [props, setProps] = createSignal({
      question: "Choose one",
      options: [
        { value: "one", label: "One", recommended: true },
        { value: "two", label: "Two" },
      ],
      disabled: false,
      onSelect,
    });
    const view = mountSolid(() => <OptionCard props={props()} />, { container });
    flush();
    const second = view.getByRole("radio", { name: "Two" });
    second.click();
    flush();
    expect(second.getAttribute("aria-checked")).toBe("true");

    setProps((current) => ({ ...current, disabled: true }));
    flush();
    second.click();
    expect(second.getAttribute("aria-checked")).toBe("true");
    expect(second.hasAttribute("disabled")).toBe(true);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("two");

    setProps((current) => ({ ...current, question: "Next question", disabled: false }));
    flush();
    const recommended = view.getByRole("radio", { name: "OneRecommended" });
    expect(recommended.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(recommended);
  });
});
