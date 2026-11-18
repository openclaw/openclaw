import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import type {
  ChatCompaction,
  MessageGroup as MessageGroupData,
} from "../../../lib/chat/chat-types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";

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

it("preserves raw tool summaries and live headlines while respecting hidden tools", async () => {
  const base = {
    kind: "group" as const,
    role: "tool",
    visibleContent: "none" as const,
    timestamp: 1000,
    isStreaming: false,
  };
  const groups: MessageGroupData[] = [
    {
      ...base,
      key: "tools",
      messages: [
        {
          key: "read",
          hasVisibleContent: false,
          message: {
            role: "assistant",
            content: [
              { type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } },
            ],
          },
        },
      ],
    },
    {
      ...base,
      key: "compaction",
      messages: [],
      compaction: {
        kind: "compaction",
        key: "compaction",
        phase: "complete",
        label: "Compacted context",
        timestamp: 2000,
      },
    },
  ];
  const view = mountSolid(() => (
    <ActivityGroup
      groups={groups}
      options={{ showReasoning: false, showToolCalls: false, isToolMessageExpanded: () => true }}
      presentation="standalone"
    />
  ));
  expect(view.container.textContent).toContain("Compacted context");
  expect(view.container.textContent).not.toContain("README.md");
  const shown = mountSolid(() => (
    <ActivityGroup groups={groups} options={{ showReasoning: false }} presentation="standalone" />
  ));
  expect(shown.container.querySelector(".chat-activity-group__summary")?.textContent).toContain(
    "File reads, compacted context",
  );
  const raw = groups[0]!;
  const entry = raw.messages[0]!;
  const liveRead = {
    ...raw,
    runId: "live-run",
    messages: [
      {
        ...entry,
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } },
          ],
          __openclawToolStreamLive: true,
          __openclaw: { runId: "live-run" },
        },
      },
    ],
  };
  const live = mountSolid(() => (
    <ActivityGroup
      groups={[{ ...groups[1]!, runId: "live-run" }, liveRead]}
      options={{
        showReasoning: false,
        runActive: true,
        bubbleMode: true,
        activityRunId: "live-run",
        bubbleActivityGroupKey: "compaction",
      }}
      presentation="standalone"
    />
  ));
  await expect
    .poll(() => live.container.querySelector(".chat-activity-group__summary")?.textContent)
    .toContain("Reading README.md");
  const failure = mountSolid(() => (
    <ActivityGroup
      groups={[
        {
          ...liveRead,
          messages: [
            {
              ...entry,
              message: {
                role: "toolResult",
                toolCallId: "read",
                toolName: "read",
                isError: true,
                content: "Permission denied",
                __openclaw: { runId: "live-run" },
              },
            },
          ],
        },
        {
          ...groups[1]!,
          runId: "live-run",
          compaction: { ...groups[1]!.compaction!, phase: "active", label: "Compacting" },
        },
      ]}
      options={{
        showReasoning: false,
        runActive: true,
        bubbleMode: true,
        activityRunId: "live-run",
        bubbleActivityGroupKey: "tools",
      }}
      presentation="standalone"
    />
  ));
  await expect
    .poll(
      () =>
        failure.container.querySelector(
          ".chat-activity-group__summary .chat-activity-group__label--live",
        )?.textContent,
    )
    .toBe("Compacting");
});
