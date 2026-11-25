import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type {
  ChatCompaction,
  MessageGroup as MessageGroupData,
} from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { MessageGroup } from "./chat-message-group-view.tsx";

it("keeps idle compaction visible with tools hidden and preserves its disclosure through completion", async () => {
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
        tokensBefore: phase() === "complete" ? 80_000 : undefined,
        tokensAfter: phase() === "complete" ? 20_000 : undefined,
        durationMs: phase() === "complete" ? 2500 : undefined,
      },
    });
    return (
      <MessageGroup group={group()} options={{ showReasoning: false, showToolCalls: false }} />
    );
  });
  const row = (await view.findByText("Compacting")).closest<HTMLDetailsElement>("details")!;
  expect(row.open).toBe(false);
  expect(row.querySelector(".chat-tool-kv")).toBeNull();
  row.open = true;
  complete();
  flush();
  expect(view.container.querySelector(".chat-compaction-activity")).toBe(row);
  expect(row.open).toBe(true);
  expect(row.textContent).toContain("Compacted context");
  await expect.poll(() => row.textContent).toContain("saved 60k tokens (75%)");
  expect(row.textContent).toContain("Duration: 2.5s");
  expect(view.container.querySelector(".chat-divider")).toBeNull();
});
