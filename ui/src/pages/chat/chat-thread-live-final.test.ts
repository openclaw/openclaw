import { describe, expect, it } from "vitest";
import { extractTextCached } from "../../lib/chat/message-extract.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { coalesceStreamRuns } from "./chat-thread-grouping.ts";
import { projectTranscriptMessageIndex } from "./components/chat-transcript-message-index.ts";
import { rememberLiveTerminalRun } from "./terminal-message-identity.ts";

const person = (id: string) => ({
  senderId: id,
  senderName: id,
  senderIdentity: { type: "profile", id },
});
const user = (sendId: string, sender: string, seq: number) => ({
  role: "user",
  content: sendId,
  timestamp: seq * 10,
  __openclaw: { id: sendId, seq, idempotencyKey: sendId + ":user", ...person(sender) },
});
const history = [user("earlier", "writer", 1), user("active", "reader", 2)];
const pending = {
  id: "pending-peer",
  runId: "peer",
  acceptedAt: 30,
  state: "queued",
  message: {
    role: "user",
    content: "Peer follow-up",
    timestamp: 30,
    __openclaw: { id: "pending:pending-peer", ...person("writer") },
  },
} as const;
function props(overrides: Partial<BuildChatItemsProps> = {}): BuildChatItemsProps {
  return {
    paneId: "live-final",
    sessionKey: "agent:main:live-final",
    messages: history,
    toolMessages: [],
    streamSegments: [],
    stream: "The answer being read.",
    streamStartedAt: 21,
    runId: "active",
    runWorking: true,
    showToolCalls: true,
    pendingInputs: [pending],
    ...overrides,
  };
}
function project(input: BuildChatItemsProps) {
  return coalesceAgentRunFrames(coalesceStreamRuns(buildChatItems(input)));
}
function completed() {
  return rememberLiveTerminalRun(
    { role: "assistant", content: "The answer being read.", timestamp: 40 },
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
      const local = {
        id: "active-local",
        sendRunId: "active",
        text: "Current input",
        createdAt: 10,
        sendAttempts: 1,
        sendState: "sending" as const,
      };
      const accepted = {
        ...pending,
        id: "active-input",
        runId: "active",
        acceptedAt: 20,
        message: {
          role: "user",
          content: local.text,
          timestamp: 20,
          __openclaw: { id: "pending:active-input" },
        },
      };
      for (const pendingInputs of [[], [accepted], [accepted, pending]]) {
        if (!localQueue && pendingInputs.length === 0) {
          continue;
        }
        const rows = buildChatItems(
          props({
            messages: [],
            queue: localQueue ? [local] : [],
            runId,
            stream: "",
            pendingInputs,
          }),
        );
        expect(
          rows.flatMap((item) =>
            item.kind === "group"
              ? item.messages.map(({ message }) => extractTextCached(message))
              : item.kind === "reading-indicator"
                ? ["Working"]
                : [],
          ),
        ).toEqual([
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
      const before = project(props({ pendingInputs }));
      const after = project(
        props({
          messages: [...history, completed()],
          pendingInputs,
          stream: null,
          runId: null,
          runWorking: false,
        }),
      );
      const frames = [before, after].map((items) => {
        const runFrames = items.filter((item) => item.kind === "agent-run-frame");
        expect(runFrames).toHaveLength(1);
        const frame = runFrames[0]!;
        expect(frame).toMatchObject({ runId: "active", boundaryId: "send:active" });
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
  it.each([
    { label: "visible history", messages: history },
    {
      label: "a hidden trailing assistant row",
      messages: [...history, { role: "assistant", content: "", timestamp: 40 }],
    },
  ])("keeps older queued inputs at the live edge with $label", ({ messages }) => {
    const stale = {
      ...pending,
      acceptedAt: 5,
      message: { ...pending.message, timestamp: 5 },
    };
    const items = project(
      props({ messages, pendingInputs: [stale], stream: null, runId: null, runWorking: false }),
    );
    const visibleMessages = items.flatMap((item) =>
      item.kind === "group" ? item.messages.map((source) => source.message) : [],
    );
    expect(visibleMessages).toEqual([...history, stale.message]);
  });
  it.each(["interrupted", "cancelled"] as const)(
    "keeps earlier %s automation before a newly submitted message and its canonical receipt",
    (state) => {
      const automation = {
        ...pending,
        id: "earlier-automation",
        runId: "automation-run",
        state,
        message: {
          role: "user",
          content: "Earlier scheduled maintenance",
          timestamp: 30,
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          senderSession: {
            sessionKey: "agent:main:cron:maintenance:run:earlier",
            label: "Scheduled maintenance",
          },
          __openclaw: { id: "pending:earlier-automation" },
        },
      };
      const submitted = user("New follow-up", "reader", 4);
      const submitting = {
        id: "new-follow-up",
        sendRunId: "New follow-up",
        text: "New follow-up",
        createdAt: 40,
        sendSubmittedAtMs: 40,
        sendState: "submitting" as const,
      };
      const disposition =
        state === "interrupted"
          ? "Interrupted before the agent started it. It will not run automatically; copy it and send again."
          : "Cancelled before the agent started it. It will not run automatically; copy it and send again.";
      const originalRows = ["earlier", "active", "Earlier scheduled maintenance", disposition];
      for (const { overrides, expected } of [
        { overrides: {}, expected: originalRows },
        {
          overrides: { queue: [submitting] },
          expected: [...originalRows, "New follow-up"],
        },
        {
          overrides: {
            messages: [...history, submitted],
            queue: [submitting],
            pendingInputs: [
              automation,
              { ...pending, acceptedAt: 5, message: { ...pending.message, timestamp: 5 } },
            ],
          },
          expected: [...originalRows, "New follow-up", "Peer follow-up"],
        },
      ]) {
        const items = buildChatItems(
          props({
            pendingInputs: [automation],
            stream: null,
            runId: null,
            runWorking: false,
            ...overrides,
          }),
        );
        const visibleRows = items.flatMap((item) =>
          item.kind === "group"
            ? item.messages.map(({ message }) => extractTextCached(message))
            : item.kind === "notice"
              ? [item.text]
              : [],
        );
        expect(visibleRows).toEqual(expected);
      }
    },
  );
  it("already attributes a streaming reply to the same participant as its terminal", () => {
    const before = project(props());
    const frame = before.find((item) => item.kind === "agent-run-frame");
    expect(frame?.kind).toBe("agent-run-frame");
    if (frame?.kind !== "agent-run-frame") {
      throw new Error("Missing active frame");
    }
    const stream = frame.parts.find((part) => part.kind === "stream-run");
    expect(stream).toMatchObject({
      replyToSender: { id: "reader" },
      replyToMessage: { message: history[1] },
    });
  });
  it("indexes rendered stream bubbles as reader anchors before they persist", () => {
    const items = project(props());
    const frame = items.find((item) => item.kind === "agent-run-frame");
    if (frame?.kind !== "agent-run-frame") {
      throw new Error("Missing active frame");
    }
    const stream = frame.parts.find((part) => part.kind === "stream-run");
    const key = stream?.parts.find((part) => part.kind === "stream")?.key;
    expect(key).toBeDefined();
    const index = projectTranscriptMessageIndex(
      items,
      new Map(),
      { assistantName: "Assistant", userId: "reader", userName: "Reader" },
      new Map(),
    );
    expect(index.transcriptMessageKeys.get(key!)).toBe(frame.key);
  });
  it("keeps streamed anchor keys after earlier messages in the same frame", () => {
    const commentary = {
      role: "assistant",
      phase: "commentary",
      content: "Earlier work",
      timestamp: 21,
      __openclaw: { id: "commentary", seq: 3, runId: "active" },
    };
    const latestCommentary = {
      ...commentary,
      content: "Continuing work",
      timestamp: 22,
      __openclaw: { id: "latest-commentary", seq: 4, runId: "active" },
    };
    const items = project(props({ messages: [...history, commentary, latestCommentary] }));
    const frame = items.find((item) => item.kind === "agent-run-frame");
    if (frame?.kind !== "agent-run-frame") {
      throw new Error("Missing mixed frame");
    }
    const group = frame.parts.find((part) => part.kind === "group");
    expect(group?.messages[0]?.message).toBe(commentary);
    const index = projectTranscriptMessageIndex(
      [frame],
      new Map(),
      { assistantName: "Assistant" },
      new Map(),
    );
    expect(index.transcriptMessageKeys.keys().next().value).toBe(group?.messages[0]?.key);
  });
  it("keeps standalone activity messages addressable for replies and anchors", () => {
    const message = {
      role: "toolResult",
      toolCallId: "standalone-call",
      content: "Stored tool result",
      timestamp: 1,
      __openclaw: { id: "activity-message", seq: 1 },
    };
    const groups = buildChatItems(
      props({
        messages: [message],
        pendingInputs: [],
        stream: null,
        runId: null,
        runWorking: false,
      }),
    ).filter((item) => item.kind === "group");
    expect(groups).toHaveLength(1);
    const items = coalesceAgentRunFrames([
      { kind: "activity-run", key: "standalone-activity", groups },
    ]);
    expect(items[0]?.kind).toBe("activity-run");
    const loaded = new Map();
    const index = projectTranscriptMessageIndex(
      items,
      new Map(),
      { assistantName: "Assistant" },
      loaded,
    );
    expect(index.transcriptMessageKeys.get(groups[0]!.messages[0]!.key)).toBe(
      "standalone-activity",
    );
    expect(index.messageRowKeysById.get("activity-message")).toBe("standalone-activity");
    expect(loaded.get("activity-message")).toMatchObject({
      message,
      messageId: groups[0]!.messages[0]!.key,
    });
  });

  it("does not reorder authoritative history when a late terminal has a canonical receipt", () => {
    const canonical = {
      role: "assistant",
      content: "Canonical later output",
      timestamp: 40,
      __openclaw: { id: "canonical", seq: 4, runId: "active" },
    };
    rememberLiveTerminalRun(canonical, "active");
    const messages = [...history, user("intervening", "writer", 3), canonical];
    const items = buildChatItems(props({ messages, stream: null, runId: null, runWorking: false }));
    const groups = items.filter((item) => item.kind === "group");
    expect(groups.flatMap((group) => group.messages.map((source) => source.message))).toEqual(
      expect.arrayContaining(messages),
    );
    const intervening = groups.findIndex((group) =>
      group.messages.some((source) => source.message === messages[2]),
    );
    const final = groups.findIndex((group) =>
      group.messages.some((source) => source.message === canonical),
    );
    expect(final).toBeGreaterThan(intervening);
  });
});
