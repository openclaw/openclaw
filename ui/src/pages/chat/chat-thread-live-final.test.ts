import { describe, expect, it } from "vitest";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import {
  groupsOf,
  message as simpleMessage,
  messagesOf,
  nativeMessage,
  pendingText,
  person,
  queued,
} from "./chat-thread-fixtures.test-support.ts";
import { coalesceStreamRuns } from "./chat-thread-grouping.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { projectTranscriptIndex } from "./components/chat-transcript-message-index.ts";
import { rememberLiveTerminalRun } from "./terminal-message-identity.ts";

const user = (sendId: string, sender: string, seq: number) =>
  nativeMessage("user", sendId, seq * 10, {
    id: sendId,
    seq,
    idempotencyKey: sendId + ":user",
    ...person(sender),
  });
const assistant = (content: string, timestamp: number, id: string, seq: number) =>
  nativeMessage("assistant", content, timestamp, { id, seq, runId: "active" });
const history = [user("earlier", "writer", 1), user("active", "reader", 2)];
const pending = pendingText("Peer follow-up", 30, {
  id: "pending-peer",
  runId: "peer",
  message: { __openclaw: { id: "pending:pending-peer", ...person("writer") } },
});
const staleInput = () => ({
  ...pending,
  acceptedAt: 5,
  message: { ...pending.message, timestamp: 5 },
});
function build(overrides: Partial<BuildChatItemsProps> = {}) {
  return buildChatItems(
    createProps({
      paneId: "live-final",
      sessionKey: "agent:main:live-final",
      messages: history,
      stream: "The answer being read.",
      streamStartedAt: 21,
      runId: "active",
      runWorking: true,
      pendingInputs: [pending],
      ...overrides,
    }),
  );
}
const settled = { stream: null, runId: null, runWorking: false };
function project(overrides: Partial<BuildChatItemsProps> = {}) {
  return coalesceAgentRunFrames(coalesceStreamRuns(build(overrides)));
}
function visibleRows(
  items: ReturnType<typeof build>,
  extra: "notice" | "reading-indicator" = "notice",
) {
  return items.flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message }) => extractTextCached(message))
      : item.kind === extra
        ? [item.kind === "notice" ? item.text : "Working"]
        : [],
  );
}
function indexItems(
  items: ReturnType<typeof coalesceAgentRunFrames>,
  labels: Parameters<typeof projectTranscriptIndex>[2] = { assistantName: "Assistant" },
) {
  const chain = {
    collapsedItems: items,
    transcriptItems: items,
    continuations: new Map(),
    searchActive: false,
  };
  return projectTranscriptIndex(chain, new Map(), labels);
}
function completed() {
  return rememberLiveTerminalRun(
    simpleMessage("assistant", "The answer being read.", 40),
    "active",
  );
}

describe("live terminal continuity with pending collaborators", () => {
  it.each([
    { runId: null, localQueue: true },
    { runId: "active", localQueue: true },
    { runId: "active", localQueue: false },
  ])(
    "keeps the active input before progress through custody with runId=$runId, localQueue=$localQueue",
    ({ runId, localQueue }) => {
      const local = queued("active-local", "Current input", 10, "sending", {
        sendRunId: "active",
        sendAttempts: 1,
      });
      const accepted = pendingText(local.text, 20, { id: "active-input", runId: "active" });
      for (const pendingInputs of [[], [accepted], [accepted, pending]]) {
        if (!localQueue && pendingInputs.length === 0) {
          continue;
        }
        const rows = build({
          messages: [],
          queue: localQueue ? [local] : [],
          runId,
          stream: "",
          pendingInputs,
        });
        expect(visibleRows(rows, "reading-indicator")).toEqual([
          "Current input",
          "Working",
          ...(pendingInputs.includes(pending) ? ["Peer follow-up"] : []),
        ]);
      }
    },
  );
  it.each([false, true])(
    "keeps the live reply and terminal before queued custody (system=%s)",
    (system) => {
      const provenance = system
        ? { kind: "internal_system", sourceTool: "main_session_restart_recovery" }
        : undefined;
      const pendingInputs = [{ ...pending, message: { ...pending.message, provenance } }];
      const frames = [
        project({ pendingInputs }),
        project({
          messages: [...history, completed()],
          pendingInputs,
          ...settled,
        }),
      ].map((items) => {
        const runFrames = items.filter((item) => item.kind === "agent-run-frame");
        expect(runFrames).toEqual([
          expect.objectContaining({ runId: "active", boundaryId: "send:active" }),
        ]);
        const frame = runFrames[0]!;
        const peer = items.findIndex((item) =>
          item.kind === "notice"
            ? item.key.includes("peer")
            : item.kind === "group" &&
              item.role === "user" &&
              item.sender?.id === "writer" &&
              item.messages.some((source) => source.key.includes("peer")),
        );
        expect(items.indexOf(frame)).toBeLessThan(peer);
        if (system) {
          expect(items[peer]).toMatchObject({ kind: "notice", startsTurn: true });
          expect(items[peer]).not.toHaveProperty("boundaryId");
        }
        return frame;
      });
      const parts = frames[0]?.parts.flatMap((part) =>
        part.kind === "stream-run" ? part.parts : [],
      );
      expect(parts?.map((part) => part.kind)).toEqual(["stream", "reading-indicator"]);
      expect(frames[1]?.key).toBe(frames[0]?.key);
    },
  );
  it.each(["visible history", "hidden trailing row", "canonical late terminal"])(
    "keeps authoritative order with %s before older custody",
    (shape) => {
      const canonical = assistant("Canonical later output", 40, "canonical", 4);
      const lateTerminal = shape === "canonical late terminal";
      if (lateTerminal) {
        rememberLiveTerminalRun(canonical, "active");
      }
      const messages = lateTerminal
        ? [...history, user("intervening", "writer", 3), canonical]
        : shape === "hidden trailing row"
          ? [...history, { role: "assistant", content: "", timestamp: 40 }]
          : history;
      const stale = staleInput();
      const items = project({
        messages,
        pendingInputs: [lateTerminal ? pending : stale],
        ...settled,
      });
      const groups = items.flatMap((item) =>
        item.kind === "agent-run-frame" ? groupsOf(item.parts) : groupsOf([item]),
      );
      const visible = messagesOf(groups);
      if (lateTerminal) {
        expect(visible).toEqual(expect.arrayContaining(messages));
        const [intervening, final] = [messages[2], canonical].map((message) =>
          groups.findIndex((group) => group.messages.some((source) => source.message === message)),
        );
        expect(final).toBeGreaterThan(intervening!);
      } else {
        expect(visible).toEqual([...history, stale.message]);
      }
    },
  );
  it.each(["interrupted", "cancelled"] as const)(
    "keeps earlier %s automation before a newly submitted message and its canonical receipt",
    (state) => {
      const automation = pendingText("Earlier scheduled maintenance", 30, {
        id: "earlier-automation",
        runId: "automation-run",
        state,
        message: {
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          senderSession: {
            sessionKey: "agent:main:cron:maintenance:run:earlier",
            label: "Scheduled maintenance",
          },
        },
      });
      const submitted = user("New follow-up", "reader", 4);
      const submitting = queued("new-follow-up", "New follow-up", 40, "submitting", {
        sendRunId: "New follow-up",
        sendSubmittedAtMs: 40,
      });
      const disposition =
        state === "interrupted"
          ? "Delivery interrupted. This saved agent update is not scheduled to retry."
          : "This agent update was cancelled before delivery.";
      const originalRows = ["earlier", "active", "Earlier scheduled maintenance", disposition];
      const check = (overrides: Partial<BuildChatItemsProps>, expected = originalRows) =>
        expect(
          visibleRows(build({ pendingInputs: [automation], ...settled, ...overrides })),
        ).toEqual(expected);
      check({});
      check({ queue: [submitting] }, [...originalRows, "New follow-up"]);
      check(
        {
          messages: [...history, submitted],
          queue: [submitting],
          pendingInputs: [automation, staleInput()],
        },
        [...originalRows, "New follow-up", "Peer follow-up"],
      );
    },
  );
  it.each([false, true])(
    "indexes stream anchors in presentation order (earlier commentary: %s)",
    (withCommentary) => {
      const commentary = { ...assistant("Earlier work", 21, "commentary", 3), phase: "commentary" };
      const latest = {
        ...assistant("Continuing work", 22, "latest-commentary", 4),
        phase: "commentary",
      };
      const items = project({
        messages: withCommentary ? [...history, commentary, latest] : history,
      });
      const frame = items.find((item) => item.kind === "agent-run-frame");
      if (frame?.kind !== "agent-run-frame") {
        throw new Error("Missing active frame");
      }
      const stream = frame.parts.find((part) => part.kind === "stream-run");
      expect(stream).toMatchObject({
        replyToSender: { id: "reader" },
        replyToMessage: { message: history[1] },
      });
      const key = stream?.parts.find((part) => part.kind === "stream")?.key;
      expect(key).toBeDefined();
      const index = indexItems(
        withCommentary ? [frame] : items,
        withCommentary
          ? undefined
          : { assistantName: "Assistant", userId: "reader", userName: "Reader" },
      );
      expect(index.transcriptMessageKeys.get(key!)).toBe(frame.key);
      if (withCommentary) {
        const group = frame.parts.find((part) => part.kind === "group");
        expect(group?.messages[0]?.message).toBe(commentary);
        expect(index.transcriptMessageKeys.keys().next().value).toBe(group?.messages[0]?.key);
      }
    },
  );
  it("keeps standalone activity messages addressable for replies and anchors", () => {
    const message = nativeMessage(
      "toolResult",
      "Stored tool result",
      1,
      { id: "activity-message", seq: 1 },
      { toolCallId: "standalone-call" },
    );
    const groups = groupsOf(
      build({
        messages: [message],
        pendingInputs: [],
        ...settled,
      }),
    );
    expect(groups).toHaveLength(1);
    const items = coalesceAgentRunFrames([
      { kind: "activity-run", key: "standalone-activity", groups },
    ]);
    expect(items[0]?.kind).toBe("activity-run");
    const index = indexItems(items);
    expect(index.transcriptMessageKeys.get(groups[0]!.messages[0]!.key)).toBe(
      "standalone-activity",
    );
    expect(index.messageRowKeysById.get("activity-message")).toBe("standalone-activity");
    expect(index.loadedReplySources.get("activity-message")).toMatchObject({
      message,
      messageId: groups[0]!.messages[0]!.key,
    });
  });
});
