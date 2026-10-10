import { html, render, type LitElement } from "lit";
import { expect, it, vi } from "vitest";
import type { SettingsSaveIndicatorProps } from "./settings-save-indicator.ts";
import { renderSettingsSegmented } from "./settings-ui.ts";
import "./settings-save-indicator.ts";
import startupStyles from "../styles.css?inline";

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
    render(
      html`<fieldset ?disabled=${busy}>
        ${renderSettingsSegmented({
          value: "first",
          disabled,
          ariaLabel: "Schedule",
          options: [
            { value: "first", label: "First" },
            { value: "second", label: "Second" },
            { value: "locked", label: "Locked", disabled: true },
          ],
          onChange,
        })}
      </fieldset>`,
      container,
    );
  const disabledStates = () =>
    [...container.querySelectorAll("input[type=radio]")].map((radio) => radio.matches(":disabled"));
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
