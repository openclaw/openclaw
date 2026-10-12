import { html, render, type LitElement } from "lit";
import { expect, it, vi } from "vitest";
import type { SettingsSaveIndicatorProps } from "./settings-save-indicator.tsx";
import { renderSettingsSegmented } from "./settings-ui.ts";
import "./settings-save-indicator.tsx";
import startupStyles from "../styles.css?inline";

function drawRadioGroups(
  container: HTMLElement,
  { value = "first", busy = false, disabled = false, expanded = false } = {},
  onChange = vi.fn(),
) {
  const options = [
    { value: "first", label: "First" },
    { value: "second", label: "Second" },
    { value: "locked", label: "Locked", disabled: true },
  ];
  render(
    html`<fieldset ?disabled=${busy}>
      ${renderSettingsSegmented({
        value,
        disabled,
        ariaLabel: "Schedule",
        options: expanded ? [...options, { value: "third", label: "Third" }] : options,
        onChange,
      })}${renderSettingsSegmented({
        value: "second",
        options,
        ariaLabel: "Other schedule",
        onChange,
      })}
    </fieldset>`,
    container,
  );
}

it("animates Applying before lazy settings styles load", async () => {
  const container = document.createElement("div");
  // Keep lazy route keyframes from masking a missing startup animation owner.
  const root = container.attachShadow({ mode: "open" });
  document.body.append(container);
  try {
    render(
      html`<style>
          ${startupStyles}
        </style>
        <openclaw-settings-save-indicator
          .props=${
            {
              status: "idle",
              lastError: null,
              needsApply: true,
              applying: true,
              applyDisabled: false,
              onRetry: vi.fn(),
              onSave: vi.fn(),
              onReload: vi.fn(),
              onApply: vi.fn(),
            } satisfies SettingsSaveIndicatorProps
          }
        ></openclaw-settings-save-indicator>`,
      root,
    );
    const indicator = root.querySelector<LitElement>("openclaw-settings-save-indicator")!;
    await indicator.updateComplete;
    const spinner = indicator.querySelector<SVGElement>(".settings-save-indicator__spinner svg")!;
    const animations = spinner.getAnimations();
    expect(animations.length).toBeGreaterThan(0);
    const animation = animations[0]!;
    const duration = Number(animation.effect!.getComputedTiming().duration);
    expect(duration).toBeGreaterThan(0);
    animation.pause();
    animation.currentTime = duration / 4;
    const transform = new DOMMatrixReadOnly(getComputedStyle(spinner).transform);
    expect(transform.a).toBeCloseTo(0);
    expect(transform.b).toBeCloseTo(1);
  } finally {
    render(null, root);
    container.remove();
  }
});

it("restores segmented controls after fieldset busy state while preserving disabled options", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const onChange = vi.fn();
  const draw = (busy: boolean, disabled = false) =>
    drawRadioGroups(container, { busy, disabled }, onChange);
  const disabledStates = () =>
    [...container.querySelector('[role="radiogroup"]')!.querySelectorAll("input[type=radio]")].map(
      (radio) => radio.matches(":disabled"),
    );
  try {
    draw(false);
    expect(disabledStates()).toEqual([false, false, true]);
    draw(true);
    expect(disabledStates()).toEqual([true, true, true]);
    draw(true);
    expect(disabledStates()).toEqual([true, true, true]);
    container.querySelector<HTMLElement>('input[type=radio][value="second"]')?.click();
    expect(onChange).not.toHaveBeenCalled();
    draw(false);
    expect(disabledStates()).toEqual([false, false, true]);
    container.querySelector<HTMLElement>('input[type=radio][value="second"]')?.click();
    expect(onChange).toHaveBeenCalledWith("second", expect.any(HTMLElement));
    onChange.mockClear();
    draw(true, true);
    expect(disabledStates()).toEqual([true, true, true]);
    draw(false, true);
    expect(disabledStates()).toEqual([true, true, true]);
    container.querySelector<HTMLElement>('input[type=radio][value="second"]')?.click();
    expect(onChange).not.toHaveBeenCalled();
    draw(false);
    expect(disabledStates()).toEqual([false, false, true]);
  } finally {
    render(null, container);
    container.remove();
  }
});

it("keeps externally updated radio selections checked and independent as options change", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const draw = (value: string, expanded = false) => drawRadioGroups(container, { value, expanded });
  const selected = () =>
    [...container.querySelectorAll('[role="radiogroup"]')].map((group) =>
      [...group.querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value),
    );
  try {
    draw("second");
    expect(selected()).toEqual([["second"], ["second"]]);
    draw("first");
    expect(selected()).toEqual([["first"], ["second"]]);
    draw("third", true);
    expect(selected()).toEqual([["third"], ["second"]]);
    draw("second", true);
    expect(selected()).toEqual([["second"], ["second"]]);
  } finally {
    render(null, container);
    container.remove();
  }
});
