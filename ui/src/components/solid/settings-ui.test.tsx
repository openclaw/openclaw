import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
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
  "%s uses the current activation callback synchronously and restores rejected changes",
  (_kind, Toggle) => {
    const calls: [string, boolean][] = [];
    const record = (name: string) => (checked: boolean) => calls.push([name, checked]);
    const [updated, setUpdated] = createSignal(false);
    const view = render(() => (
      <Toggle
        title="Notifications"
        ariaLabel="Enabled"
        checked={false}
        onAct={updated() ? record("current") : record("old")}
        onChange={(checked) => {
          calls.push(["change", checked]);
          return false;
        }}
      />
    ));
    setUpdated(true);
    flush();
    const input = view.getByRole("switch") as HTMLInputElement;
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

it("applies controlled radio changes without replacing focused inputs", () => {
  const [value, setValue] = createSignal("first");
  const view = render(() => (
    <SettingsSegmented value={value()} options={options} onChange={(next) => void setValue(next)} />
  ));
  const last = view.getByRole("radio", { name: "Last" }) as HTMLInputElement;
  last.focus();
  last.click();
  flush();
  expect(last.checked).toBe(true);
  expect(view.getByRole("radio", { name: "Last" })).toBe(last);
  expect(document.activeElement).toBe(last);
});
