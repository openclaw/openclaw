/* @vitest-environment jsdom */
import { createMemo, createSignal, For } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { collapseCompletedTurnWork } from "../chat-turn-presentation.ts";
import { WorkGroupSummary } from "./chat-work-group-summary.tsx";

it.each([false, true])(
  "keeps expanded completed work after history prepend (bubble=%s)",
  async (bubbleMode) => {
    const result = (id: string) => ({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: id,
      timestamp: 1000,
    });
    const earlier = result("A");
    const later = result("B");
    const final = { role: "assistant", content: "Inspection complete", timestamp: 2000 };
    const [history, setHistory] = createSignal([later, final]);
    const [expanded, setExpanded] = createSignal(new Set<string>());
    const work = createMemo(() =>
      collapseCompletedTurnWork(
        groupMessages(
          history().map((message) => ({
            kind: "message" as const,
            key: message === final ? "final" : message === later ? "B" : "A",
            message,
          })),
          {},
          undefined,
          true,
        ),
        { sessionKey: "agent:main:dashboard:pagination", runWorking: false, bubbleMode },
      ).filter((item) => item.kind === "work-group"),
    );
    const view = mountSolid(() => (
      <For each={work()}>
        {(item) => (
          <WorkGroupSummary
            item={item}
            options={{
              bubbleMode,
              expanded: expanded().has(item.key),
              onToggle: () => setExpanded((current) => new Set([...current, item.key])),
            }}
          />
        )}
      </For>
    ));
    try {
      flush();
      const button = () =>
        view.container.querySelector<HTMLButtonElement>(".chat-work-group > button");
      await waitForSolid(() => expect(button()).not.toBeNull());
      button()!.click();
      await waitForSolid(() => expect(button()?.getAttribute("aria-expanded")).toBe("true"));
      setHistory([earlier, later, final]);
      flush();
      await waitForSolid(() => {
        expect(button()?.getAttribute("aria-expanded")).toBe("true");
        expect(view.container.textContent).toContain("2 tool calls");
      });
    } finally {
      view.unmount();
    }
  },
);
