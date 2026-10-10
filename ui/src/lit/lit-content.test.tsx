import { html } from "lit";
import { createSignal, flush } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { LitContent } from "./lit-content.tsx";

it("updates a Lit leaf without replacing its input and releases it with its Solid owner", () => {
  const [label, setLabel] = createSignal("First");
  const view = mountSolid(() => <LitContent value={html`<label>${label()}<input /></label>`} />);
  try {
    flush();
    const input = view.container.querySelector("input")!;
    input.value = "Draft";
    setLabel("Second");
    flush();
    expect(view.container.textContent).toBe("Second");
    expect(view.container.querySelector("input")).toBe(input);
    expect(input.value).toBe("Draft");
  } finally {
    view.unmount();
  }
  expect(view.container.childNodes).toHaveLength(0);
});

it("keeps sanitized content directly inside its styled host", () => {
  const view = mountSolid(() => (
    <LitContent
      tag="div"
      class="chat-text"
      value={html`<p>Summary</p>
        <pre>Result</pre>`}
    />
  ));
  flush();
  expect(view.container.querySelector(".chat-text > p")?.textContent).toBe("Summary");
  expect(view.container.querySelector(".chat-text > :last-child")?.tagName).toBe("PRE");
});
