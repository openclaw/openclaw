/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { mountTestTranscript } from "../test-helpers/chat-transcript-native.tsx";
import { createMessageGroup } from "./chat-message.test-support.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import type { NativeTranscriptView } from "./chat-transcript-rows.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
  type TestContentRow,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

function row(key: string, view: NativeTranscriptView): TestContentRow {
  return { kind: "content", key, content: new GuardedTranscriptItem([view], view) };
}

it("loads stream and run rows without losing the adjacent message or the latest snapshot", async () => {
  const message = createMessageGroup(
    { role: "user", content: "Keep this message", timestamp: 1 },
    "user",
  );
  const groupOptions = { showReasoning: false, onReply: () => {} };
  const stable = row("message", { kind: "group", group: message, options: groupOptions });
  const initial = row("tail", {
    kind: "group",
    group: createMessageGroup(
      { role: "assistant", content: "Before the run", timestamp: 2 },
      "assistant",
    ),
    options: { showReasoning: false },
  });
  const view = await mountTestTranscript("lazy-transcript", [stable, initial]);
  try {
    await waitForSolid(() => expect(view.container.textContent).toContain("Keep this message"));
    const messageGroup = view.container.querySelector(".chat-group.user");
    expect(messageGroup).not.toBeNull();
    const reply = view.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reply to message"]',
    );
    expect(reply).not.toBeNull();
    reply!.focus();
    const stream = {
      kind: "stream" as const,
      key: "stream:answer",
      startedAt: 2,
      isStreaming: true,
      text: "Initial run snapshot",
      thinking: "",
    };
    view.renderRows([stable, row("tail", { kind: "stream", parts: [stream], options: {} })]);
    view.renderRows([
      row("message", {
        kind: "group",
        group: message,
        options: { ...groupOptions, assistantName: "Updated assistant" },
      }),
      row("tail", {
        kind: "stream",
        parts: [{ ...stream, text: "Latest run snapshot", isStreaming: false }],
        options: {},
      }),
    ]);
    await waitForSolid(() => expect(view.container.textContent).toContain("Latest run snapshot"));
    expect(view.container.querySelector(".chat-group.user")).toBe(messageGroup);
    expect(document.activeElement).toBe(reply);
    const answer = createMessageGroup(
      { role: "assistant", content: "Completed run answer", timestamp: 3 },
      "assistant",
    );
    const staleToggle = vi.fn();
    const currentToggle = vi.fn();
    const work = { key: "work", groups: [answer], durationMs: null };
    view.renderRows([
      stable,
      row("tail", {
        kind: "work",
        item: work,
        options: { expanded: false, onToggle: staleToggle },
      }),
    ]);
    view.renderRows([
      stable,
      row("tail", {
        kind: "work",
        item: work,
        options: { expanded: false, onToggle: currentToggle },
      }),
    ]);
    await waitForSolid(() =>
      expect(view.container.querySelector(".chat-work-group button")).not.toBeNull(),
    );
    view.container.querySelector<HTMLButtonElement>(".chat-work-group button")!.click();
    expect(staleToggle).not.toHaveBeenCalled();
    expect(currentToggle).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".chat-group.user")).toBe(messageGroup);
    expect(document.activeElement).toBe(reply);
    view.renderRows([
      stable,
      row("tail", {
        kind: "frame",
        frame: {
          kind: "agent-run-frame",
          key: "run:answer",
          runId: "run",
          boundaryId: "boundary",
          outcome: { kind: "completed", actionOwner: answer.messages[0]! },
          parts: [answer],
        },
        options: {
          streamOptions: {},
          renderGroupOptions: () => ({ showReasoning: false }),
          isWorkExpanded: () => false,
          onToggleWork: () => {},
        },
      }),
    ]);
    await waitForSolid(() => expect(view.container.textContent).toContain("Completed run answer"));
    flush();
    expect(view.container.querySelector(".chat-group.user")).toBe(messageGroup);
    expect(document.activeElement).toBe(reply);
  } finally {
    view.transcript.dispose();
  }
});
