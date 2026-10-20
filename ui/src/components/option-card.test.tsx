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

  it("accents and focuses the recommended choice, then calls its selection handler", () => {
    const onSelect = vi.fn();
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
  });

  it("always renders a skip affordance and calls its dismissal handler", () => {
    const onSkip = vi.fn();
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
  });

  it.each(["textarea", "button"] as const)(
    "preserves focus on a %s without retrying a refused recommendation",
    (tagName) => {
      const control = document.createElement(tagName);
      const target = document.createElement("div");
      container.append(control, target);
      control.focus();
      const [props, setProps] = createSignal({
        question: "What would you like to do first?",
        options: [
          { value: "chat", label: "Talk to my agent", recommended: true },
          { value: "channels", label: "See all channels" },
        ],
        disabled: false,
      });
      mountSolid(() => <OptionCard props={props()} />, { container: target });
      flush();

      expect(document.activeElement).toBe(control);
      control.blur();
      setProps((current) => ({ ...current, disabled: true }));
      flush();
      setProps((current) => ({
        ...current,
        disabled: false,
        options: current.options.map((option) => ({ ...option, description: "Updated details" })),
      }));
      flush();

      expect(document.activeElement).toBe(document.body);
    },
  );

  it("holds a disabled recommendation and retains selection and rows across display updates", () => {
    const onSelect = vi.fn();
    const [props, setProps] = createSignal({
      question: "Choose one",
      options: [
        { value: "one", label: "One", recommended: true },
        { value: "two", label: "Two" },
      ],
      disabled: true,
      onSelect,
    });
    const view = mountSolid(() => <OptionCard props={props()} />, { container });
    flush();
    const recommended = view.getByRole("radio", { name: "OneRecommended" });
    const second = view.getByRole("radio", { name: "Two" });
    expect(document.activeElement).toBe(document.body);

    setProps((current) => ({
      ...current,
      options: current.options.map((option) => ({ ...option, description: "Updated details" })),
    }));
    flush();
    expect(view.getAllByRole("radio")[0]).toBe(recommended);
    expect(view.getAllByRole("radio")[1]).toBe(second);
    expect(document.activeElement).toBe(document.body);

    setProps((current) => ({ ...current, disabled: false }));
    flush();
    expect(document.activeElement).toBe(recommended);
    second.focus();
    second.click();
    flush();
    expect(second.getAttribute("aria-checked")).toBe("true");

    setProps((current) => ({ ...current, disabled: true }));
    flush();
    second.click();
    expect(second.getAttribute("aria-checked")).toBe("true");
    expect(second.hasAttribute("disabled")).toBe(true);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("two");

    setProps((current) => ({
      ...current,
      disabled: false,
      options: current.options.map((option) => ({ ...option, description: "More details" })),
    }));
    flush();
    expect(view.getAllByRole("radio")[0]).toBe(recommended);
    expect(view.getAllByRole("radio")[1]).toBe(second);
    expect(second.getAttribute("aria-checked")).toBe("true");

    setProps((current) => ({ ...current, question: "Next question", disabled: false }));
    flush();
    expect(recommended.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(recommended);
  });

  it("cancels a disabled recommendation when the next request has none", () => {
    const [props, setProps] = createSignal({
      question: "Choose one",
      options: [{ value: "one", label: "One", recommended: true }],
      disabled: true,
    });
    const view = mountSolid(() => <OptionCard props={props()} />, { container });
    flush();

    setProps((current) => ({
      ...current,
      question: "Choose freely",
      options: [{ value: "one", label: "One", recommended: false }],
    }));
    flush();
    setProps((current) => ({ ...current, disabled: false }));
    flush();

    expect(view.getByRole("radio").getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(document.body);
  });
});
