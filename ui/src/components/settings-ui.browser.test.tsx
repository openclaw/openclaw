import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  SettingsSaveIndicator,
  type SettingsSaveIndicatorProps,
} from "./settings-save-indicator.tsx";
import { SettingsSegmented } from "./solid/settings-ui.tsx";
import startupStyles from "../styles.css?inline";

function mountRadioGroups(onChange = vi.fn()) {
  const [state, setState] = createSignal({
    value: "first",
    busy: false,
    disabled: false,
    expanded: false,
  });
  const options = [
    { value: "first", label: "First" },
    { value: "second", label: "Second" },
    { value: "locked", label: "Locked", disabled: true },
  ];
  const view = mountSolid(() => (
    <fieldset disabled={state().busy}>
      <SettingsSegmented
        value={state().value}
        disabled={state().disabled}
        ariaLabel="Schedule"
        options={state().expanded ? [...options, { value: "third", label: "Third" }] : options}
        onChange={onChange}
      />
      <SettingsSegmented
        value="second"
        options={options}
        ariaLabel="Other schedule"
        onChange={onChange}
      />
    </fieldset>
  ));
  const draw = (next: Partial<ReturnType<typeof state>>) => {
    setState((previous) => ({ ...previous, ...next }));
    flush();
  };
  flush();
  return { ...view, draw };
}

it("animates Applying before lazy settings styles load", async () => {
  const container = document.createElement("div");
  // Keep lazy route keyframes from masking a missing startup animation owner.
  const root = container.attachShadow({ mode: "open" });
  document.body.append(container);
  let view: ReturnType<typeof mountSolid> | undefined;
  try {
    const target = root.appendChild(document.createElement("div"));
    const indicatorProps = {
      status: "idle",
      lastError: null,
      needsApply: true,
      applying: true,
      applyDisabled: false,
      onRetry: vi.fn(),
      onSave: vi.fn(),
      onReload: vi.fn(),
      onApply: vi.fn(),
    } satisfies SettingsSaveIndicatorProps;
    view = mountSolid(
      () => (
        <>
          <style>{startupStyles}</style>
          <SettingsSaveIndicator {...indicatorProps} />
        </>
      ),
      { container: target },
    );
    await waitForSolid(() =>
      expect(target.querySelector(".settings-save-indicator__spinner svg")).not.toBeNull(),
    );
    const spinner = target.querySelector<SVGElement>(".settings-save-indicator__spinner svg")!;
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
    view?.unmount();
    container.remove();
  }
});

it("restores segmented controls after fieldset busy state while preserving disabled options", () => {
  const onChange = vi.fn();
  const view = mountRadioGroups(onChange);
  const { container } = view;
  const draw = (busy: boolean, disabled = false) => view.draw({ busy, disabled });
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
    view.unmount();
  }
});

it("keeps externally updated radio selections checked and independent as options change", () => {
  const view = mountRadioGroups();
  const { container } = view;
  const draw = (value: string, expanded = false) => view.draw({ value, expanded });
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
    view.unmount();
  }
});
