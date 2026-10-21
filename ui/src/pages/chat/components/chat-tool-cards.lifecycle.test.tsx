/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";

it("remeasures each disclosure's own content on pointer and focus interactions", async () => {
  const { container } = mountSolid(() => (
    <>
      <ChatToolCard
        card={{ id: "first", name: "exec", args: { command: "first command" } }}
        options={{ messageKey: "first", expanded: false, onToggleExpanded: vi.fn() }}
      />
      <ChatToolCard
        card={{ id: "second", name: "exec", args: { command: "second command" } }}
        options={{ messageKey: "second", expanded: false, onToggleExpanded: vi.fn() }}
      />
    </>
  ));
  await waitForSolid(() => expect(container.querySelectorAll(".chat-tool-row")).toHaveLength(2));
  const [first, second] = [...container.querySelectorAll<HTMLElement>(".chat-tool-row")];
  let firstWidth = 80;
  for (const [row, width] of [
    [first!, () => firstWidth],
    [second!, () => 20],
  ] as const) {
    Object.defineProperties(row.querySelector(".chat-tool-disclosure__content")!, {
      scrollWidth: { get: width },
      clientWidth: { value: 50 },
    });
    row.dispatchEvent(new Event("pointerenter"));
  }
  expect(first!.classList.contains("chat-tool-disclosure--overflowing")).toBe(true);
  expect(second!.classList.contains("chat-tool-disclosure--overflowing")).toBe(false);
  firstWidth = 20;
  first!.dispatchEvent(new FocusEvent("focus"));
  expect(first!.classList.contains("chat-tool-disclosure--overflowing")).toBe(false);
});

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
