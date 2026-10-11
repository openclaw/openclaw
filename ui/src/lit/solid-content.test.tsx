import { html } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { LitContent } from "./solid-bridge.ts";

afterEach(() => document.body.replaceChildren());

it("updates an isolated Lit outlet and retires its directives without replacing Solid siblings", () => {
  const disconnected = vi.fn();
  class ObserveRemoval extends AsyncDirective {
    render(value: string) {
      return value;
    }

    override disconnected() {
      disconnected();
    }
  }
  const observeRemoval = directive(ObserveRemoval);
  const [label, setLabel] = createSignal("First");
  const onClick = vi.fn(() => setLabel("Second"));
  const container = document.createElement("div");
  document.body.append(container);
  const { unmount } = mountSolid(
    () => (
      <section>
        <input aria-label="Solid sibling" />
        <LitContent
          render={() => html`<button @click=${onClick}>${observeRemoval(label())}</button>`}
        />
      </section>
    ),
    { container },
  );
  flush();
  const sibling = container.querySelector("input")!;
  const button = container.querySelector("button")!;
  const outlet = button.parentElement!;
  try {
    sibling.value = "Typed value";
    expect(button.textContent).toBe("First");
    button.click();
    flush();
    expect(onClick).toHaveBeenCalledOnce();
    expect(button.textContent).toBe("Second");
    expect(container.querySelector("button")).toBe(button);
    expect(container.querySelector("input")).toBe(sibling);
    expect(sibling.value).toBe("Typed value");
    expect(disconnected).not.toHaveBeenCalled();
  } finally {
    unmount();
  }
  expect(disconnected).toHaveBeenCalledOnce();
  expect(outlet.querySelector("button")).toBeNull();
  expect(container.childNodes).toHaveLength(0);
  setLabel("After disposal");
  flush();
  expect(outlet.textContent).toBe("");
  expect(disconnected).toHaveBeenCalledOnce();
});
