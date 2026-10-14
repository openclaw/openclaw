import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSegmented, SettingsToggle, SettingsToggleRow } from "./settings-ui.tsx";

afterEach(cleanup);

it("uses the visible title to name a toggle without moving caller-owned DOM", () => {
  const title = document.createElement("span");
  title.textContent = "Rich title";
  const view = render(() => (
    <SettingsToggleRow title={title} checked={false} onChange={() => {}} />
  ));
  expect(title.parentElement).toBe(view.container.querySelector(".settings-row__title"));
  expect(view.getByRole("switch", { name: "Rich title" })).toBeTruthy();
});

it("runs the current standalone activation callback before proposing the change", () => {
  const calls: string[] = [];
  const [updated, setUpdated] = createSignal(false);
  const view = render(() => (
    <SettingsToggle
      ariaLabel="Enabled"
      checked={false}
      onAct={updated() ? () => calls.push("current") : () => calls.push("old")}
      onChange={() => {
        calls.push("change");
        return false;
      }}
    />
  ));
  setUpdated(true);
  flush();
  const input = view.getByRole("switch") as HTMLInputElement;
  input.click();
  expect(calls).toEqual(["current", "change"]);
  expect(input.checked).toBe(false);
});

it("keeps direct activation synchronous and restores a rejected switch", () => {
  const onAct = vi.fn();
  const onChange = vi.fn(() => false);
  const view = render(() => (
    <SettingsToggleRow title="Notifications" checked={false} onAct={onAct} onChange={onChange} />
  ));
  const input = view.getByRole("switch") as HTMLInputElement;
  fireEvent.click(view.getByText("Notifications", { selector: ".settings-row__title" }));
  expect(onAct).toHaveBeenCalledExactlyOnceWith(true);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  expect(input.checked).toBe(false);
  onAct.mockClear();
  onChange.mockClear();
  fireEvent.keyDown(input, { key: "ArrowRight" });
  expect(onAct).toHaveBeenCalledExactlyOnceWith(true);
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  expect(input.checked).toBe(false);
});

it("honors switch direction and restores interaction after a busy fieldset", () => {
  const [busy, setBusy] = createSignal(true);
  const [checked, setChecked] = createSignal(false);
  const onChange = vi.fn((next: boolean) => {
    setChecked(next);
  });
  const view = render(() => (
    <fieldset disabled={busy()} dir="rtl">
      <SettingsToggle ariaLabel="Enabled" checked={checked()} onChange={onChange} />
    </fieldset>
  ));
  const input = view.getByRole("switch") as HTMLInputElement;
  input.click();
  expect(onChange).not.toHaveBeenCalled();
  setBusy(false);
  flush();
  input.click();
  flush();
  expect(input.checked).toBe(true);
  // jsdom does not resolve inherited direction; explicit direction tests the same input contract.
  input.style.direction = "rtl";
  fireEvent.keyDown(input, { key: "ArrowRight" });
  expect(onChange).toHaveBeenLastCalledWith(false);
  flush();
  expect(input.checked).toBe(false);
});

it("keeps radio groups independent, skips disabled options and rolls back rejected keyboard choice", () => {
  const onChange = vi.fn(() => false);
  const onReselect = vi.fn();
  const options = [
    { value: "first", label: "First" },
    { value: "locked", label: "Locked", disabled: true },
    { value: "last", label: "Last" },
  ];
  const view = render(() => (
    <>
      <SettingsSegmented
        value="first"
        options={options}
        ariaLabel="Schedule"
        onChange={onChange}
        onReselect={onReselect}
      />
      <SettingsSegmented value="first" options={options} ariaLabel="Other" onChange={() => {}} />
    </>
  ));
  const groups = view.getAllByRole("radiogroup");
  const first = groups[0]!.querySelector<HTMLInputElement>('input[value="first"]')!;
  const last = groups[0]!.querySelector<HTMLInputElement>('input[value="last"]')!;
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowRight" });
  expect(document.activeElement).toBe(last);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("last", last.parentElement);
  expect(first.checked).toBe(true);
  expect(last.checked).toBe(false);
  expect(groups[1]!.querySelector<HTMLInputElement>('input[value="first"]')!.checked).toBe(true);
  first.click();
  expect(onReselect).toHaveBeenCalledExactlyOnceWith("first", first.parentElement);
  const locked = groups[0]!.querySelector<HTMLInputElement>('input[value="locked"]')!;
  locked.click();
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("applies controlled radio changes without replacing focused inputs", () => {
  const [value, setValue] = createSignal("first");
  const view = render(() => (
    <SettingsSegmented
      value={value()}
      options={[
        { value: "first", label: "First" },
        { value: "last", label: "Last" },
      ]}
      onChange={(next) => {
        setValue(next);
      }}
    />
  ));
  const last = view.getByRole("radio", { name: "Last" }) as HTMLInputElement;
  last.focus();
  last.click();
  flush();
  expect(last.checked).toBe(true);
  expect(view.getByRole("radio", { name: "Last" })).toBe(last);
  expect(document.activeElement).toBe(last);
});
