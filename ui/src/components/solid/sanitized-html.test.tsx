import { createSignal, flush } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { SanitizedHtml } from "./sanitized-html.tsx";

it("retains sanitized markup nodes while accessibility attributes update", () => {
  const [markup, setMarkup] = createSignal('<span class="hljs-string">safe</span>');
  const [label, setLabel] = createSignal("Status");
  const view = mountSolid(() => (
    <SanitizedHtml tag="pre" role="group" aria-label={label()} tabindex={0} html={markup()} />
  ));
  const pre = view.container.querySelector("pre")!;
  const span = pre.querySelector("span");
  expect(pre.getAttribute("role")).toBe("group");
  expect(pre.getAttribute("aria-label")).toBe("Status");
  expect(pre.tabIndex).toBe(0);

  setLabel("Health");
  setMarkup('<span class="hljs-string">safe</span>');
  flush();
  expect(pre.getAttribute("aria-label")).toBe("Health");
  expect(pre.querySelector("span")).toBe(span);

  setMarkup('<span class="hljs-number">42</span>');
  flush();
  expect(pre.textContent).toBe("42");
  expect(pre.querySelector("span")).not.toBe(span);
});
