import { createMemo, createSignal, flush, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { liveValue } from "./live-value.ts";

it("commits controlled values without untracked reads and preserves input selection", () => {
  const [value, setValue] = createSignal("draft");
  const [identity, setIdentity] = createSignal(1);
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  const setter = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");
  try {
    function ControlledTextarea() {
      const committedValue = createMemo(value);
      const valueRef = liveValue(committedValue);
      return (
        <Show when={identity()} keyed>
          {(_identity) => <textarea ref={valueRef} />}
        </Show>
      );
    }
    const view = mountSolid(() => <ControlledTextarea />);
    flush();
    const input = view.container.querySelector("textarea")!;
    expect(input.value).toBe("draft");
    input.setSelectionRange(2, 2);
    setter.mockClear();
    setValue("draft");
    flush();
    expect(setter).not.toHaveBeenCalled();
    expect(input.selectionStart).toBe(2);
    setValue("replaced");
    flush();
    expect(input.value).toBe("replaced");
    setIdentity(2);
    flush();
    const replacement = view.container.querySelector("textarea")!;
    expect(replacement).not.toBe(input);
    expect(replacement.value).toBe("replaced");
    expect(
      warnings.mock.calls.filter(([message]) => String(message).includes("STRICT_READ_UNTRACKED")),
    ).toEqual([]);
  } finally {
    setter.mockRestore();
    warnings.mockRestore();
  }
});

it.each(["late-value", "late-ref"] as const)(
  "applies a prepared value when a conditional input first appears (%s)",
  (mode) => {
    const [entry, setEntry] = createSignal<{ value: string } | undefined>(
      mode === "late-value" ? undefined : { value: "initial" },
    );
    const [shown, setShown] = createSignal(mode !== "late-ref");
    const view = mountSolid(() => {
      if (mode === "late-ref") {
        const bind = liveValue(() => entry()!.value);
        return <Show when={shown()}>{(_shown) => <input ref={bind} />}</Show>;
      }
      return (
        <Show when={entry()}>{(current) => <input ref={liveValue(() => current().value)} />}</Show>
      );
    });
    expect(view.container.querySelector("input")).toBeNull();
    setEntry({ value: "ready" });
    flush();
    setShown(true);
    flush();
    const input = view.container.querySelector("input")!;
    expect(input.value).toBe("ready");
    input.focus();
    input.setSelectionRange(2, 2);
    setEntry({ value: "ready" });
    flush();
    expect(view.container.querySelector("input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(2);
    setEntry({ value: "" });
    flush();
    expect(input.value).toBe("");
  },
);
