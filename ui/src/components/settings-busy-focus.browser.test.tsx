import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { nextFrame } from "../test-helpers/modal-dialog.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SettingsSegmented, SettingsToggleRow } from "./solid/settings-ui.tsx";

function mountBusyControls() {
  const [busy, setBusy] = createSignal(false);
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
        disabled={busy()}
        onChange={onToggle}
      />
      <SettingsSegmented
        ariaLabel="Mode"
        value={mode()}
        disabled={busy()}
        options={[
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ]}
        onChange={onMode}
      />
      <SettingsSegmented
        mode="buttons"
        ariaLabel="Size"
        value={size()}
        disabled={busy()}
        options={[
          { value: "small", label: "Small" },
          { value: "large", label: "Large" },
        ]}
        onChange={onSize}
      />
    </>
  ));
  const settle = () => {
    setBusy(false);
    flush();
  };
  return { ...view, onToggle, onMode, onSize, settle };
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
  try {
    const toggle = view.container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    toggle.focus();
    await userEvent.keyboard(" ");
    await expectFocusKeptWhileBusy(toggle);
    await userEvent.keyboard(" ");
    expect(view.onToggle).toHaveBeenCalledExactlyOnceWith(true);
    expect(toggle.checked).toBe(true);
    view.settle();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.hasAttribute("aria-disabled")).toBe(false);
    await userEvent.keyboard(" ");
    expect(view.onToggle).toHaveBeenLastCalledWith(false);
  } finally {
    view.unmount();
  }
});

it("keeps a busy radio focused and ignores arrow keys until the save settles", async () => {
  const view = mountBusyControls();
  const radio = (value: string) =>
    view.container.querySelector<HTMLInputElement>(`input[type=radio][value="${value}"]`)!;
  try {
    radio("first").focus();
    await userEvent.keyboard("{ArrowRight}");
    await expectFocusKeptWhileBusy(radio("second"));
    await userEvent.keyboard("{ArrowRight}");
    expect(view.onMode).toHaveBeenCalledExactlyOnceWith("second", expect.any(HTMLElement));
    expect(document.activeElement).toBe(radio("second"));
    expect(radio("second").checked).toBe(true);
    view.settle();
    expect(radio("second").hasAttribute("aria-disabled")).toBe(false);
    await userEvent.keyboard("{ArrowRight}");
    expect(view.onMode).toHaveBeenLastCalledWith("first", expect.any(HTMLElement));
    expect(document.activeElement).toBe(radio("first"));
  } finally {
    view.unmount();
  }
});

it("keeps a busy segmented button focused and ignores Enter until the save settles", async () => {
  const view = mountBusyControls();
  const button = (name: string) =>
    [...view.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
  try {
    button("Large").focus();
    await userEvent.keyboard("{Enter}");
    await expectFocusKeptWhileBusy(button("Large"));
    await userEvent.keyboard("{Enter}");
    expect(view.onSize).toHaveBeenCalledExactlyOnceWith("large");
    expect(button("Large").getAttribute("aria-pressed")).toBe("true");
    view.settle();
    expect(document.activeElement).toBe(button("Large"));
    expect(button("Large").hasAttribute("aria-disabled")).toBe(false);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Enter}");
    expect(view.onSize).toHaveBeenLastCalledWith("small");
  } finally {
    view.unmount();
  }
});

it("keeps a locked switch reachable with Tab but ignores Space", async () => {
  const onChange = vi.fn();
  const view = mountSolid(() => (
    <SettingsToggleRow title="Audit log" checked={false} disabled onChange={onChange} />
  ));
  try {
    const toggle = view.container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    await userEvent.tab();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    await userEvent.keyboard(" ");
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle.checked).toBe(false);
  } finally {
    view.unmount();
  }
});
