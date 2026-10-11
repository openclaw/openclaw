import { html } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { LitRouteHost } from "../app/lit-route-host.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { LitContent } from "./solid-bridge.ts";
import { renderSolidSnapshot } from "./solid-snapshot.ts";

it("renders inert Solid artwork inside a connected Lit route", () => {
  const view = mountSolid(() => (
    <LitRouteHost
      renderValue={() =>
        html`${renderSolidSnapshot(() => (
          <svg aria-label="Avatar artwork">
            <circle cx="4" cy="5" r="2" />
          </svg>
        ))}`
      }
    />
  ));
  flush();
  const artwork = view.container.querySelector('svg[aria-label="Avatar artwork"]');
  expect(artwork?.querySelector("circle")?.getAttribute("cx")).toBe("4");
  expect(artwork?.namespaceURI).toBe("http://www.w3.org/2000/svg");
});

it("retains a Lit island's nodes and disconnects its directives on Solid disposal", () => {
  const disconnected = vi.fn();
  class Lifetime extends AsyncDirective {
    render(label: string) {
      return html`<input aria-label="Island field" .value=${label} />`;
    }
    override disconnected() {
      disconnected();
    }
  }
  const lifetime = directive(Lifetime);
  const [label, setLabel] = createSignal("First");
  const clicked = vi.fn();
  const view = mountSolid(() => (
    <article class="sidebar-markdown" onClick={clicked}>
      <LitContent render={() => html`<p>${lifetime(label())}</p>`} />
    </article>
  ));
  try {
    flush();
    const article = view.container.querySelector("article.sidebar-markdown")!;
    const field = article.querySelector<HTMLInputElement>("p > input")!;
    expect(field.value).toBe("First");
    article.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toHaveBeenCalledOnce();
    setLabel("Second");
    flush();
    expect(article.querySelector("p > input")).toBe(field);
    expect(field.value).toBe("Second");
    expect(disconnected).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
  expect(disconnected).toHaveBeenCalledOnce();
  expect(view.container.childNodes).toHaveLength(0);
});
