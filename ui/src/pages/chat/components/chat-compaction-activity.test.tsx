import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type {
  ChatCompaction,
  MessageGroup as MessageGroupData,
} from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { MessageGroup } from "./chat-message-group-view.tsx";

it("keeps idle compaction visible with tools hidden and preserves its disclosure through completion", () => {
  let complete!: () => void;
  const view = mountSolid(() => {
    const [phase, setPhase] = createSignal<ChatCompaction["phase"]>("active");
    complete = () => setPhase("complete");
    const group = (): MessageGroupData => ({
      kind: "group",
      key: "manual",
      role: "tool",
      messages: [],
      visibleContent: "none",
      timestamp: 1000,
      isStreaming: false,
      compaction: {
        kind: "compaction",
        key: phase() === "active" ? "live-manual-operation" : "durable-manual-event",
        phase: phase(),
        label: phase() === "active" ? "Compacting" : "Compacted context",
        timestamp: 1000,
        ...(phase() === "complete" ? { metric: "saved 60k tokens (75%)", durationMs: 2500 } : {}),
      },
    });
    return (
      <MessageGroup group={group()} options={{ showReasoning: false, showToolCalls: false }} />
    );
  });
  const row = view.container.querySelector<HTMLDetailsElement>(".chat-compaction-activity")!;
  expect(row).not.toBeNull();
  expect(row.open).toBe(false);
  expect(row.textContent).toContain("Compacting");
  row.open = true;
  complete();
  flush();
  expect(view.container.querySelector(".chat-compaction-activity")).toBe(row);
  expect(row.open).toBe(true);
  expect(row.textContent).toContain("Compacted context");
  expect(row.textContent).toContain("saved 60k tokens (75%)");
  expect(row.textContent).toContain("Duration: 2.5s");
  expect(view.container.querySelector(".chat-divider")).toBeNull();
});
