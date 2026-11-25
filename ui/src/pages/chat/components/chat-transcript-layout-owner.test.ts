// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import {
  footprintLayout,
  mountedVirtualizer,
  phases,
  scheduledCallbacks,
} from "./chat-transcript-layout.test-support.ts";
import { projectTranscriptIndex, projectTranscriptRows } from "./chat-transcript-message-index.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./chat-transcript.test-support.ts";

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

it("invalidates a warmed tool row height while retaining its identity", () => {
  const activity = { kind: "activity-run" as const, key: "tool", groups: [] };
  const compaction = {
    kind: "group" as const,
    key: "compact",
    role: "tool",
    messages: [],
    visibleContent: "none" as const,
    timestamp: 2,
    isStreaming: false,
    compaction: {
      kind: "compaction" as const,
      key: "compact",
      phase: "complete" as const,
      timestamp: 2,
      label: "Compacted context",
    },
  };
  const tool = { kind: "item" as const, key: activity.key, item: activity, revision: "measured" };
  const standalone = { kind: "item" as const, key: compaction.key, item: compaction };
  const neighbors = [tool, standalone];
  const inserted = { kind: "content" as const, key: "barrier", after: tool.key, content: null };
  expect(projectTranscriptRows(neighbors, [inserted], true)).toEqual([tool, inserted, standalone]);
  const compacted = projectTranscriptRows(neighbors, [], true);
  const revision = "measured:compact-activity";
  expect(compacted[0]).toMatchObject({ key: tool.key, revision, compactActivity: true });
  expect(compacted[1]).toBe(standalone);
  expect(projectTranscriptRows(neighbors, [], true)).toBe(compacted);

  const toolGroup = {
    ...compaction,
    compaction: undefined,
    messages: [{ key: "read", message: { role: "toolResult" }, hasVisibleContent: false }],
  };
  const index = (groups: MessageGroup[]) => {
    const row = projectTranscriptIndex(
      { transcriptItems: [{ ...activity, groups }], continuations: new Map(), searchActive: false },
      new Map(),
      { assistantName: "Assistant" },
    ).rows[0];
    if (row?.kind !== "item") {
      throw new Error("Expected an activity row");
    }
    return row;
  };
  const before = index([toolGroup]);
  const after = index([toolGroup, compaction]);
  expect(after.key).toBe(before.key);
  expect(after.revision).not.toBe(before.revision);
});

describe("transcript layout callbacks", () => {
  it.each(phases)("ignores an obsolete $label after reconnecting", (phase) => {
    const scheduled = scheduledCallbacks(phase.idle);
    const { layout, writeRows } = footprintLayout();
    const old = mountedVirtualizer(layout);
    layout.persistRows(old.instance, false);
    if (phase.advance) {
      scheduled.takeFrame()();
    }
    const obsolete = phase.advance && phase.idle ? scheduled.takeIdle() : scheduled.takeFrame();
    layout.disconnect();
    old.dispose();
    const current = mountedVirtualizer(layout, 250);
    try {
      layout.persistRows(current.instance, false);
      expect(scheduled.frames.size).toBe(1);
      obsolete();
      layout.persistRows(current.instance, false);
      expect(scheduled.frames.size).toBe(1);
      expect(scheduled.idleCallbacks.size).toBe(0);
      scheduled.takeFrame()();
      (phase.idle ? scheduled.takeIdle() : scheduled.takeFrame())();
      expect(writeRows).toHaveBeenCalledTimes(1);
      expect(Object.values(writeRows.mock.calls[0]![0])).toEqual([250]);
      expect(layout.rowMinimum(0)).toBe(300);
    } finally {
      layout.disconnect();
      current.dispose();
    }
  });
});
