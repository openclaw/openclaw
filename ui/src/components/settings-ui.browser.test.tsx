import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { saveIndicatorProps } from "./settings-save-indicator.test-support.ts";
import { SettingsSaveIndicator } from "./settings-save-indicator.tsx";
import { SettingsSegmented, SettingsToggleRow } from "./solid/settings-ui.tsx";
import startupStyles from "../styles.css?inline";

const optionsFor = (...values: string[]) =>
  values.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }));

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

it("restores inherited fieldset restrictions when busy state clears", () => {
  const [busy, setBusy] = createSignal(true);
  const onChange = vi.fn();
  const { container } = mountSolid(() => (
    <fieldset disabled={busy()}>
      <SettingsSegmented
        value="first"
        options={optionsFor("first", "second")}
        onChange={onChange}
      />
    </fieldset>
  ));
  const second = container.querySelector<HTMLInputElement>('input[value="second"]')!;
  expect(second.matches(":disabled")).toBe(true);
  second.click();
  expect(onChange).not.toHaveBeenCalled();
  setBusy(false);
  flush();
  expect(second.matches(":disabled")).toBe(false);
  second.click();
  expect(onChange).toHaveBeenCalledWith("second", expect.any(HTMLElement));
});

function mountBusyControls() {
  const [busy, setBusy] = createSignal(false);
  const [disabled, setDisabled] = createSignal(false);
  const [checked, setChecked] = createSignal(false);
  const [mode, setMode] = createSignal("first");
  const [size, setSize] = createSignal("small");
  const save = <T,>(set: (value: T) => void) =>
    vi.fn((value: T) => {
      set(value);
      setBusy(true);
    });
  const onToggle = save(setChecked);
  const onMode = save(setMode);
  const onSize = save(setSize);
  const view = mountSolid(() => (
    <>
      <SettingsToggleRow
        title="Audit log"
        checked={checked()}
        saving={busy()}
        disabled={disabled()}
        onChange={onToggle}
      />
      <SettingsSegmented
        ariaLabel="Mode"
        value={mode()}
        saving={busy()}
        disabled={disabled()}
        options={optionsFor("first", "second")}
        onChange={onMode}
      />
      <SettingsSegmented
        mode="buttons"
        ariaLabel="Size"
        value={size()}
        saving={busy()}
        disabled={disabled()}
        options={optionsFor("small", "large")}
        onChange={onSize}
      />
    </>
  ));
  const settle = () => {
    setBusy(false);
    flush();
  };
  return { ...view, onToggle, onMode, onSize, settle, setDisabled };
}

const unavailable = (element: Element) => element.matches(':disabled, [aria-disabled="true"]');

// Browsers move focus off a natively disabled element during a later rendering update.
async function expectFocusKeptWhileBusy(control: HTMLElement) {
  await waitForSolid(() => expect(unavailable(control)).toBe(true));
  await nextFrame();
  await nextFrame();
  expect(document.activeElement).toBe(control);
  expect(control.getAttribute("aria-disabled")).toBe("true");
}

it("keeps a busy switch focused and ignores Space until the save settles", async () => {
  const view = mountBusyControls();
  const toggle = view.container.querySelector<HTMLInputElement>('input[role="switch"]')!;
  toggle.focus();
  await userEvent.keyboard(" ");
  await expectFocusKeptWhileBusy(toggle);
  await userEvent.keyboard(" ");
  view.container.querySelector<HTMLElement>(".settings-row__title")!.click();
  toggle.click();
  expect(view.onToggle).toHaveBeenCalledExactlyOnceWith(true);
  expect(toggle.checked).toBe(true);
  view.settle();
  expect(document.activeElement).toBe(toggle);
  expect(toggle.hasAttribute("aria-disabled")).toBe(false);
  await userEvent.keyboard(" ");
  expect(view.onToggle).toHaveBeenLastCalledWith(false);
});

it("keeps a busy radio focused and ignores arrow keys until the save settles", async () => {
  const view = mountBusyControls();
  const radio = (value: string) =>
    view.container.querySelector<HTMLInputElement>(`input[type=radio][value="${value}"]`)!;
  radio("first").focus();
  await userEvent.keyboard("{ArrowRight}");
  await expectFocusKeptWhileBusy(radio("second"));
  await userEvent.keyboard("{ArrowRight}");
  radio("first").click();
  expect(view.onMode).toHaveBeenCalledExactlyOnceWith("second", expect.any(HTMLElement));
  expect(document.activeElement).toBe(radio("second"));
  expect(radio("second").checked).toBe(true);
  view.settle();
  expect(radio("second").hasAttribute("aria-disabled")).toBe(false);
  await userEvent.keyboard("{ArrowRight}");
  expect(view.onMode).toHaveBeenLastCalledWith("first", expect.any(HTMLElement));
  expect(document.activeElement).toBe(radio("first"));
});

it("keeps a busy segmented button focused and ignores Enter until the save settles", async () => {
  const view = mountBusyControls();
  const button = (name: string) =>
    [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
  button("Large").focus();
  await userEvent.keyboard("{Enter}");
  await expectFocusKeptWhileBusy(button("Large"));
  await userEvent.keyboard("{Enter}");
  button("Small").click();
  expect(view.onSize).toHaveBeenCalledExactlyOnceWith("large");
  expect(button("Large").getAttribute("aria-pressed")).toBe("true");
  view.settle();
  expect(document.activeElement).toBe(button("Large"));
  expect(button("Large").hasAttribute("aria-disabled")).toBe(false);
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Enter}");
  expect(view.onSize).toHaveBeenLastCalledWith("small");
});

it("keeps non-saving restrictions native when they arrive during a save", async () => {
  const view = mountBusyControls();
  const controls = [
    ...view.container.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button"),
  ];
  const toggle = view.container.querySelector<HTMLInputElement>('input[role="switch"]')!;
  toggle.focus();
  await userEvent.keyboard(" ");
  await expectFocusKeptWhileBusy(toggle);
  view.setDisabled(true);
  flush();
  await nextFrame();
  await nextFrame();
  for (const control of controls) {
    expect(control.disabled).toBe(true);
    control.focus();
    expect(document.activeElement).not.toBe(control);
    control.click();
  }
  expect(view.onToggle).toHaveBeenCalledExactlyOnceWith(true);
  expect(view.onMode).not.toHaveBeenCalled();
  expect(view.onSize).not.toHaveBeenCalled();
  view.settle();
  expect(controls.every((control) => control.disabled)).toBe(true);
  await userEvent.tab();
  expect(document.activeElement).not.toBe(toggle);
  await userEvent.keyboard(" ");
  expect(view.onToggle).toHaveBeenCalledExactlyOnceWith(true);
  expect(toggle.checked).toBe(true);
  view.setDisabled(false);
  flush();
  expect(controls.every((control) => !control.disabled)).toBe(true);
});
