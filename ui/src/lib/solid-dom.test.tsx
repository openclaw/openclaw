import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { liveValue } from "./solid-dom.ts";

it("keeps input selection when a controlled value is already current", () => {
  const [value, setValue] = createSignal("draft");
  const view = mountSolid(() => <textarea ref={liveValue(value)} />);
  const input = view.container.querySelector("textarea")!;
  input.setSelectionRange(2, 2);
  const setter = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");
  setValue("draft");
  flush();
  expect(setter).not.toHaveBeenCalled();
  expect(input.selectionStart).toBe(2);
  setValue("replaced");
  flush();
  expect(input.value).toBe("replaced");
  setter.mockRestore();
});
