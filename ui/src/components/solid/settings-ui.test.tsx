import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { SettingsSegmented, SettingsToggle, SettingsToggleRow } from "./settings-ui.tsx";

afterEach(cleanup);
const options = [
  { value: "first", label: "First" },
  { value: "last", label: "Last" },
] as const;

it.each([
  ["standalone", SettingsToggle],
  ["row", SettingsToggleRow],
] as const)(
  "%s preserves activation across refreshed props and restores rejected changes",
  (_kind, Toggle) => {
    const calls: [string, boolean][] = [];
    const record = (name: string) => (checked: boolean) => calls.push([name, checked]);
    const [updated, setUpdated] = createSignal(false);
    const [control, setControl] = createSignal({ checked: false, saving: false });
    let reject = true;
    const view = render(() => (
      <Toggle
        title="Notifications"
        ariaLabel="Enabled"
        checked={control().checked}
        saving={control().saving}
        onAct={updated() ? record("current") : record("old")}
        onChange={(checked) => {
          calls.push(["change", checked]);
          return reject ? false : undefined;
        }}
      />
    ));
    setUpdated(true);
    flush();
    const input = view.getByRole("switch") as HTMLInputElement;
    input.addEventListener(
      "click",
      () => {
        // A streamed owner frame must not reset native activation before change.
        setControl((current) => ({ ...current }));
        flush();
      },
      { capture: true, once: true },
    );
    for (const activate of [
      () =>
        Toggle === SettingsToggleRow
          ? fireEvent.click(view.getByText("Notifications", { selector: ".settings-row__title" }))
          : input.click(),
      () => fireEvent.keyDown(input, { key: "ArrowRight" }),
    ]) {
      activate();
      expect(calls).toEqual([
        ["current", true],
        ["change", true],
      ]);
      expect(input.checked).toBe(false);
      calls.length = 0;
    }
    reject = false;
    input.click();
    expect(input.checked).toBe(true);
    setControl({ checked: false, saving: true });
    flush();
    expect(input.checked).toBe(false);
    calls.length = 0;
    input.click();
    expect(calls).toEqual([]);
    setControl({ checked: true, saving: false });
    flush();
    expect(input.checked).toBe(true);
  },
);

it("isolates radio groups, skips disabled options and rolls back rejected keyboard choice", () => {
  const onChange = vi.fn(() => false);
  const onReselect = vi.fn();
  const choices = [options[0], { value: "locked", label: "Locked", disabled: true }, options[1]];
  const view = render(() => (
    <>
      <SettingsSegmented
        value="first"
        options={choices}
        ariaLabel="Schedule"
        onChange={onChange}
        onReselect={onReselect}
      />
      <SettingsSegmented value="first" options={choices} ariaLabel="Other" onChange={() => {}} />
    </>
  ));
  const groups = view.getAllByRole("radiogroup");
  const radio = (value: string, group = groups[0]!) =>
    group.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  const first = radio("first"),
    last = radio("last");
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(document.activeElement).toBe(last);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("last", last.parentElement);
  expect([first.checked, last.checked, radio("first", groups[1]).checked]).toEqual([
    true,
    false,
    true,
  ]);
  first.click();
  expect(onReselect).toHaveBeenCalledExactlyOnceWith("first", first.parentElement);
  radio("locked").click();
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("registers keyed radio refs without untracked reads and retains focused inputs", () => {
  const warnings = vi.spyOn(console, "warn");
  onTestFinished(() => warnings.mockRestore());
  const inputRef = vi.fn();
  const [choices, setChoices] = createSignal([
    options[0],
    { value: "middle", label: "Middle" },
    options[1],
  ]);
  const [value, setValue] = createSignal("first");
  const view = render(() => (
    <SettingsSegmented
      value={value()}
      options={choices()}
      inputRef={inputRef}
      onChange={(next) => void setValue(next)}
    />
  ));
  flush();
  const last = view.container.querySelector<HTMLInputElement>('input[value="last"]')!;
  expect(inputRef).toHaveBeenCalledTimes(3);
  expect(inputRef).toHaveBeenCalledWith("last", last);
  last.focus();
  setChoices([
    { value: "first", label: "First updated" },
    { value: "middle", label: "Middle updated" },
    { value: "last", label: "Last updated" },
  ]);
  flush();
  last.click();
  flush();
  expect(last.checked).toBe(true);
  expect(view.getByRole("radio", { name: "Last updated" })).toBe(last);
  expect(document.activeElement).toBe(last);
  expect(inputRef).toHaveBeenCalledTimes(3);
  expect(warnings).not.toHaveBeenCalledWith(expect.stringContaining("STRICT_READ_UNTRACKED"));
});
