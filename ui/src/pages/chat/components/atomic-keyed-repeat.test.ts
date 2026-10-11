/* @vitest-environment jsdom */
import { html, nothing, render, type ChildPart } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive } from "lit/directive.js";
import { afterEach, expect, it } from "vitest";
import { atomicKeyedRepeat } from "./atomic-keyed-repeat.ts";

const disconnected: Array<{ key: string; connected: boolean }> = [];
class ObserveRemovalDirective extends AsyncDirective {
  private key = "";
  private marker?: Node | null;
  render(key: string) {
    this.key = key;
    return nothing;
  }
  override update(part: ChildPart, [key]: [string]) {
    this.marker = part.startNode;
    return this.render(key);
  }
  override disconnected() {
    disconnected.push({ key: this.key, connected: this.marker?.isConnected ?? false });
  }
}
const observeRemoval = directive(ObserveRemovalDirective);
const host = document.createElement("div");

function enableRangeMoveFixture() {
  // jsdom proves range bookkeeping; the browser E2E proves native iframe preservation.
  Object.defineProperty(Element.prototype, "moveBefore", {
    configurable: true,
    value(this: Element, node: Node, before: Node | null) {
      this.insertBefore(node, before);
    },
  });
}

afterEach(() => {
  render(nothing, host);
  host.remove();
  disconnected.length = 0;
  Reflect.deleteProperty(Element.prototype, "moveBefore");
});

it("reorders keyed ranges, updates retained content, and disconnects removed descendants", () => {
  enableRangeMoveFixture();
  document.body.append(host);
  const show = (items: Array<{ key: string; text: string }>) =>
    render(
      atomicKeyedRepeat(
        items,
        (item) => item.key,
        (item) =>
          html`<p data-key=${item.key}>${item.text}${observeRemoval(item.key)}</p>
            <span>${item.key}</span>`,
      ),
      host,
    );
  show([
    { key: "a", text: "A" },
    { key: "b", text: "B" },
    { key: "c", text: "C" },
  ]);
  const original = [...host.querySelectorAll("p")];
  show([
    { key: "c", text: "Updated C" },
    { key: "d", text: "D" },
    { key: "a", text: "Updated A" },
  ]);
  const retained = [...host.querySelectorAll("p")];
  expect(retained.map((node) => node.dataset.key)).toEqual(["c", "d", "a"]);
  expect(retained[0]).toBe(original[2]);
  expect(retained[2]).toBe(original[0]);
  expect([...host.children].map((node) => node.textContent)).toEqual([
    "Updated C",
    "c",
    "D",
    "d",
    "Updated A",
    "a",
  ]);
  expect(original[1]?.isConnected).toBe(false);
  expect(disconnected).toEqual([{ key: "b", connected: true }]);

  render(nothing, host);
  expect(host.querySelector("p")).toBeNull();
  expect(disconnected.toSorted((a, b) => a.key.localeCompare(b.key))).toEqual(
    ["a", "b", "c", "d"].map((key) => ({ key, connected: true })),
  );
});

it("replaces existing text and template content without leaving stale nodes", () => {
  enableRangeMoveFixture();
  document.body.append(host);
  for (const previous of ["Old text", html`<article>Old template</article>`]) {
    render(previous, host);
    render(
      atomicKeyedRepeat(
        ["current"],
        (key) => key,
        (key) => html`<p>${key}</p>`,
      ),
      host,
    );
    expect(host.textContent).toBe("current");
    expect(host.children).toHaveLength(1);
    expect(host.firstElementChild?.tagName).toBe("P");
  }
});

it("keeps Lit's non-atomic prepend behavior when moveBefore is unavailable", () => {
  expect(typeof Element.prototype.moveBefore).toBe("undefined");
  class RetainedElement extends HTMLElement {
    disconnections = 0;
    disconnectedCallback() {
      this.disconnections += 1;
    }
  }
  customElements.define("atomic-repeat-fallback-probe", RetainedElement);
  document.body.append(host);
  const show = (keys: string[]) =>
    render(
      atomicKeyedRepeat(
        keys,
        (key) => key,
        (key) =>
          html`<atomic-repeat-fallback-probe data-key=${key}></atomic-repeat-fallback-probe>`,
      ),
      host,
    );
  show(["retained"]);
  const retained = host.querySelector<RetainedElement>("atomic-repeat-fallback-probe")!;
  show(["new", "retained"]);
  expect(host.lastElementChild).toBe(retained);
  expect(retained.isConnected).toBe(true);
  expect(retained.disconnections).toBe(0);
});
