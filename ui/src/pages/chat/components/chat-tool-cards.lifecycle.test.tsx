/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

it.each([
  { hasChildren: undefined, mode: "inferred" },
  { hasChildren: true, mode: "explicit" },
])(
  "connects nested tool children only after their parent expands ($mode)",
  async ({ hasChildren, mode }) => {
    const connected = vi.fn();
    customElements.define(
      `openclaw-test-lazy-tool-child-${mode}`,
      class extends HTMLElement {
        connectedCallback() {
          connected();
        }
      },
    );
    const card = { id: "lazy-parent", name: "exec", args: { command: "check" } };
    const child = document.createElement(`openclaw-test-lazy-tool-child-${mode}`);
    child.textContent = "Child";
    const [expanded, setExpanded] = createSignal(false);
    const { container } = mountSolid(() => (
      <ChatToolCard
        card={card}
        options={{
          messageKey: "lazy-parent-message",
          expanded: expanded(),
          onToggleExpanded: vi.fn(),
        }}
        hasChildren={hasChildren}
      >
        {child}
      </ChatToolCard>
    ));
    flush();
    expect(connected).not.toHaveBeenCalled();
    setExpanded(true);
    await waitForSolid(() => expect(connected).toHaveBeenCalledOnce());
    expect(container.querySelector(".chat-tool-children")?.textContent).toContain("Child");
  },
);
