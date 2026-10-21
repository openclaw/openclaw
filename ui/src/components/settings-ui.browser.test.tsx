import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { saveIndicatorProps } from "./settings-save-indicator.test-support.ts";
import { SettingsSaveIndicator } from "./settings-save-indicator.tsx";
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
  onTestFinished(() => container.remove());
  const target = root.appendChild(document.createElement("div"));
  mountSolid(
    () => (
      <>
        <style>{startupStyles}</style>
        <SettingsSaveIndicator {...saveIndicatorProps({ needsApply: true, applying: true })} />
      </>
    ),
    { container: target },
  );
  await waitForSolid(() =>
    expect(target.querySelector(".settings-save-indicator__spinner svg")).not.toBeNull(),
  );
  const spinner = target.querySelector<SVGElement>(".settings-save-indicator__spinner svg")!;
  const animation = spinner.getAnimations()[0]!;
  expect(animation).toBeDefined();
  const duration = Number(animation.effect!.getComputedTiming().duration);
  expect(duration).toBeGreaterThan(0);
  animation.pause();
  animation.currentTime = duration / 4;
  const transform = new DOMMatrixReadOnly(getComputedStyle(spinner).transform);
  expect(transform).toMatchObject({ a: expect.closeTo(0), b: expect.closeTo(1) });
});

it("restores segmented controls after fieldset busy state while preserving disabled options", () => {
  const onChange = vi.fn();
  const { container, draw } = mountRadioGroups(onChange);
  const disabledStates = (busy: boolean, disabled = false) => {
    draw({ busy, disabled });
    return [
      ...container.querySelector('[role="radiogroup"]')!.querySelectorAll("input[type=radio]"),
    ].map((radio) => radio.matches(":disabled"));
  };
  expect(disabledStates(false)).toEqual([false, false, true]);
  expect(disabledStates(true)).toEqual([true, true, true]);
  expect(disabledStates(true)).toEqual([true, true, true]);
  container.querySelector<HTMLElement>('input[type=radio][value="second"]')?.click();
  expect(onChange).not.toHaveBeenCalled();
  expect(disabledStates(false)).toEqual([false, false, true]);
  container.querySelector<HTMLElement>('input[type=radio][value="second"]')?.click();
  expect(onChange).toHaveBeenCalledWith("second", expect.any(HTMLElement));
  onChange.mockClear();
  expect(disabledStates(true, true)).toEqual([true, true, true]);
  expect(disabledStates(false, true)).toEqual([true, true, true]);
  container.querySelector<HTMLElement>('input[type=radio][value="second"]')?.click();
  expect(onChange).not.toHaveBeenCalled();
  expect(disabledStates(false)).toEqual([false, false, true]);
});

it("keeps externally updated radio selections checked and independent as options change", () => {
  const { container, draw } = mountRadioGroups();
  const selected = (value: string, expanded = false) => {
    draw({ value, expanded });
    return [...container.querySelectorAll('[role="radiogroup"]')].map((group) =>
      [...group.querySelectorAll<HTMLInputElement>("input:checked")].map((input) => input.value),
    );
  };
  expect(selected("second")).toEqual([["second"], ["second"]]);
  expect(selected("first")).toEqual([["first"], ["second"]]);
  expect(selected("third", true)).toEqual([["third"], ["second"]]);
  expect(selected("second", true)).toEqual([["second"], ["second"]]);
});
