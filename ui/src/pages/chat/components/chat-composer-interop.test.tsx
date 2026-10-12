import { html, nothing, render } from "lit";
import { createSignal, onCleanup } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { LitContent } from "./chat-composer-interop.tsx";

it("retains the input through prop updates and retires each disconnected Solid owner", () => {
  const mounted = vi.fn();
  const disposed = vi.fn();
  function NativeInput(props: { label: string; value: string }) {
    mounted();
    onCleanup(disposed);
    return (
      <label>
        {props.label}
        <textarea value={props.value} />
      </label>
    );
  }
  const view = mountSolid(() => <section />);
  const container = view.container.querySelector("section")!;
  const props = { label: "", value: "" };
  const paint = (label: string) => {
    props.label = label;
    return render(html`${solidTemplate(NativeInput, props)}`, container);
  };
  const part = paint("First draft");
  try {
    const input = view.getByRole("textbox", { name: "First draft" }) as HTMLTextAreaElement;
    input.value = "Unsent text";
    input.focus();
    input.setSelectionRange(3, 7);
    const valueWrites = vi.spyOn(HTMLTextAreaElement.prototype, "value", "set");
    paint("Current draft");
    expect(valueWrites).not.toHaveBeenCalled();
    valueWrites.mockRestore();
    expect(view.getByRole("textbox", { name: "Current draft" })).toBe(input);
    expect(input.value).toBe("Unsent text");
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 7]);
    expect(mounted).toHaveBeenCalledOnce();
    expect(disposed).not.toHaveBeenCalled();

    part.setConnected(false);
    expect(disposed).toHaveBeenCalledOnce();
    paint("Updated while disconnected");
    expect(mounted).toHaveBeenCalledOnce();
    part.setConnected(true);
    expect(view.getByRole("textbox", { name: "Updated while disconnected" })).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(2);
    part.setConnected(false);
    expect(disposed).toHaveBeenCalledTimes(2);
  } finally {
    render(nothing, container);
    view.unmount();
  }
});

it("commits initial opaque Lit content and updates it without replacing its node", () => {
  const [label, setLabel] = createSignal("Connecting");
  const view = mountSolid(() => <LitContent value={html`<div role="status">${label()}</div>`} />);
  const status = view.getByRole("status");
  expect(status.textContent).toBe("Connecting");
  setLabel("Connected");
  flush();
  expect(view.getByRole("status")).toBe(status);
  expect(status.textContent).toBe("Connected");
});

it("leaves no empty host for absent composer content", () => {
  const [content, setContent] = createSignal<unknown>(undefined);
  const view = mountSolid(() => <LitContent value={content()} />);
  expect(view.container.children).toHaveLength(0);
  setContent(html`<p>Available notice</p>`);
  flush();
  expect(view.getByText("Available notice")).toBeTruthy();
  setContent(nothing);
  flush();
  expect(view.container.children).toHaveLength(0);
});
