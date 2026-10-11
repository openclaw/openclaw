/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import "./option-card.ts";

describe("option card", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("accents and focuses the recommended choice, then emits its value", async () => {
    const onSelect = vi.fn();
    const selected = vi.fn();
    container.addEventListener("option-select", selected);
    const card = document.createElement("openclaw-option-card");
    card.props = {
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
    mountSolid(() => card, { container });
    // Solid owns the host node; its still-Lit children have a separate commit.
    await card.updateComplete;
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

  it("always renders a skip affordance and emits dismissal", async () => {
    const onSkip = vi.fn();
    const skipped = vi.fn();
    container.addEventListener("option-skip", skipped);
    const card = document.createElement("openclaw-option-card");
    card.props = {
      question: "Choose one",
      options: [
        { value: "one", label: "One" },
        { value: "two", label: "Two" },
      ],
      onSkip,
    };
    mountSolid(() => card, { container });
    await container.querySelector("openclaw-option-card")!.updateComplete;
    container.querySelector<HTMLButtonElement>(".option-card__skip")!.click();

    expect(onSkip).toHaveBeenCalledOnce();
    expect(skipped).toHaveBeenCalledOnce();
  });

  it.each(["textarea", "button"] as const)(
    "preserves focus on a %s when a recommended answer arrives",
    async (tagName) => {
      const control = document.createElement(tagName);
      const target = document.createElement("div");
      container.append(control, target);
      control.focus();
      const card = document.createElement("openclaw-option-card");
      card.props = {
        question: "What would you like to do first?",
        options: [
          { value: "chat", label: "Talk to my agent", recommended: true },
          { value: "channels", label: "See all channels" },
        ],
      };
      mountSolid(() => card, { container: target });
      await target.querySelector("openclaw-option-card")!.updateComplete;

      expect(document.activeElement).toBe(control);
    },
  );
});
