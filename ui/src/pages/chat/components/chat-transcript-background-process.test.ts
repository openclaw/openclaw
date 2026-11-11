import { describe, expect, it } from "vitest";
import { buildChatItems } from "../chat-thread-build.ts";
import { makeMessage } from "../chat-thread.test-support.ts";
import { projectTranscriptChain, projectTranscriptIndex } from "./chat-transcript-message-index.ts";
import { createTranscriptRenderDependencies } from "./chat-transcript-render-guard.ts";

const sessionKey = "agent:main:webchat:issue-196190";
const runId = "webchat-background-run";
const messages = [
  makeMessage("question", 1, { role: "user", runId }),
  makeMessage("commentary", 2, { phase: "commentary", stopReason: "toolUse", runId }),
  {
    ...makeMessage("tool", 3, { role: "toolResult", runId }),
    toolName: "read",
    toolCallId: "tool",
    __openclaw: { id: "tool", seq: 3, runId },
  },
];
const items = buildChatItems({
  paneId: "issue-196190",
  sessionKey,
  messages,
  toolMessages: [],
  streamSegments: [],
  stream: null,
  streamStartedAt: null,
  showToolCalls: true,
});
const completedAnswer = makeMessage("release notes are ready", 4, {
  phase: "final_answer",
  stopReason: "stop",
  runId,
});
const completedItems = buildChatItems({
  paneId: "issue-196190-completed",
  sessionKey,
  messages: [...messages, completedAnswer],
  toolMessages: [],
  streamSegments: [],
  stream: null,
  streamStartedAt: null,
  showToolCalls: true,
});
type TranscriptSession = NonNullable<Parameters<typeof projectTranscriptChain>[1]["session"]>;
const chainFor = (session: TranscriptSession, source = items, sourceMessages = messages) =>
  projectTranscriptChain(source, {
    sessionKey,
    messages: sourceMessages,
    runWorking: false,
    searchActive: false,
    session,
  });
const frameFor = (session: TranscriptSession) =>
  chainFor(session).transcriptItems.find((item) => item.kind === "agent-run-frame");

describe("session background exec transcript state", () => {
  it("preserves a stopped run outcome when its background process survives", () => {
    const stopped = frameFor({
      key: sessionKey,
      lastRunId: runId,
      status: "killed",
      abortedLastRun: true,
      backgroundProcessRunIds: [runId],
    });
    expect(stopped?.outcome).toEqual({ kind: "interrupted" });
    expect(stopped?.backgroundActive).toBe(true);

    const differentRun = frameFor({
      key: sessionKey,
      lastRunId: "later-run",
      status: "killed",
      abortedLastRun: true,
      backgroundProcessRunIds: [runId],
    });
    expect(differentRun?.outcome).toEqual({ kind: "active" });
    expect(differentRun?.backgroundActive).toBe(true);
  });

  it("matches the process origin even when the session's latest run is different", () => {
    const active = frameFor({
      key: sessionKey,
      lastRunId: "later-run",
      status: "interrupted",
      backgroundProcessRunIds: [runId],
    });
    expect(active?.outcome).toEqual({ kind: "active" });
    expect(active?.backgroundActive).toBe(true);

    const inactiveSessions = [
      { backgroundProcessRunIds: [] },
      { backgroundProcessRunIds: ["different-run"] },
    ];
    for (const session of inactiveSessions) {
      expect(frameFor({ key: sessionKey, status: "interrupted", ...session })?.outcome).toEqual({
        kind: "interrupted",
      });
    }
    expect(
      frameFor({
        key: sessionKey,
        status: "interrupted",
        backgroundProcessRunIds: [runId],
      })?.outcome,
    ).toEqual({ kind: "active" });
  });

  it("keeps completed answer actions while an originating background process continues", () => {
    const session: TranscriptSession = {
      key: sessionKey,
      lastRunId: "later-run",
      status: "done",
      backgroundProcessRunIds: [runId],
    };
    const sourceMessages = [...messages, completedAnswer];
    const activeChain = chainFor(session, completedItems, sourceMessages);
    const completed = activeChain.transcriptItems.find((item) => item.kind === "agent-run-frame");
    expect(completed?.outcome).toMatchObject({
      kind: "completed",
      actionOwner: { message: completedAnswer },
    });
    expect(completed?.backgroundActive).toBe(true);

    const inactiveChain = chainFor(
      { ...session, backgroundProcessRunIds: [] },
      completedItems,
      sourceMessages,
    );
    const inactive = inactiveChain.transcriptItems.find((item) => item.kind === "agent-run-frame");
    expect(inactive?.key).toBe(completed?.key);
    expect(inactive?.outcome).toEqual(completed?.outcome);
    expect(inactive?.backgroundActive).toBe(false);

    const dependenciesFor = createTranscriptRenderDependencies([], () => []);
    expect(dependenciesFor(inactive!)).not.toEqual(dependenciesFor(completed!));

    const projectRow = (chain: ReturnType<typeof chainFor>, key: string) =>
      projectTranscriptIndex(chain, new Map(), {
        assistantName: "Assistant",
        userId: "reader",
        userName: "Reader",
      }).rows.find((row) => row.key === key);
    const activeRow = projectRow(activeChain, completed!.key);
    const inactiveRow = projectRow(inactiveChain, completed!.key);
    expect(activeRow?.kind).toBe("item");
    expect(inactiveRow?.kind).toBe("item");
    expect(inactiveRow?.kind === "item" && inactiveRow.revision).not.toBe(
      activeRow?.kind === "item" && activeRow.revision,
    );
  });

  it("keeps a completed answer when later tool work shares its run", () => {
    const sourceMessages = [
      ...messages,
      completedAnswer,
      makeMessage("later-call", 5, {
        runId,
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "later-tool", name: "read", arguments: {} }],
      }),
      makeMessage("later-result", 6, {
        role: "toolResult",
        runId,
        toolCallId: "later-tool",
        toolName: "read",
        content: "Read completed.",
      }),
    ];
    const source = buildChatItems({
      paneId: "issue-196190-later-work",
      sessionKey,
      messages: sourceMessages,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    const session: TranscriptSession = { key: sessionKey, backgroundProcessRunIds: [runId] };
    const frame = chainFor(session, source, sourceMessages).transcriptItems.find(
      (item) => item.kind === "agent-run-frame",
    );

    expect(frame?.outcome).toMatchObject({
      kind: "completed",
      actionOwner: { message: completedAnswer },
    });
  });
});
