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
