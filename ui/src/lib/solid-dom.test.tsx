import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { liveValue, sanitizedHtml } from "./solid-dom.ts";

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

it("retains sanitized markup nodes until their source changes", () => {
  const [markup, setMarkup] = createSignal('<span class="hljs-string">safe</span>');
  const view = mountSolid(() => <pre ref={sanitizedHtml(markup)} />);
  const span = view.container.querySelector("span");
  setMarkup('<span class="hljs-string">safe</span>');
  flush();
  expect(view.container.querySelector("span")).toBe(span);
  setMarkup('<span class="hljs-number">42</span>');
  flush();
  expect(view.container.textContent).toBe("42");
  expect(view.container.querySelector("span")).not.toBe(span);
});
