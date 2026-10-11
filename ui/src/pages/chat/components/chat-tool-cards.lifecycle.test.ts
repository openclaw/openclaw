/* @vitest-environment jsdom */

import { html } from "lit";
import { expect, it, vi } from "vitest";
import { renderToolCard } from "./chat-tool-cards.ts";
import { renderToolFixture } from "./chat-tool-render.test-support.ts";

it("connects nested tool children only after their parent expands", async () => {
  const connected = vi.fn();
  customElements.define(
    "openclaw-test-lazy-tool-child",
    class extends HTMLElement {
      connectedCallback() {
        connected();
      }
    },
  );
  const container = document.createElement("div");
  const card = { id: "lazy-parent", name: "exec", args: { command: "check" } };
  const options = {
    messageKey: "lazy-parent-message",
    expanded: false,
    onToggleExpanded: vi.fn(),
    children: html`<openclaw-test-lazy-tool-child>Child</openclaw-test-lazy-tool-child>`,
  };
  await renderToolFixture(renderToolCard(card, options), container);
  expect(connected).not.toHaveBeenCalled();
  await renderToolFixture(renderToolCard(card, { ...options, expanded: true }), container);
  expect(connected).toHaveBeenCalledOnce();
  expect(container.querySelector(".chat-tool-children")?.textContent).toContain("Child");
});
