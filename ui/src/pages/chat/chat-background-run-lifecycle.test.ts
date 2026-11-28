import { describe, expect, it } from "vitest";
import { chatItemGroups } from "./chat-agent-run-grouping.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { createProps, makeMessage } from "./chat-thread.test-support.ts";
import { readProjectedContinuation } from "./chat-turn-boundary.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import { rememberLiveTerminalRun } from "./terminal-message-identity.ts";
import { resolveChatProjectionRunId } from "./tool-stream-snapshot.ts";

function toolRun(runId: string, offset = 0) {
  return [
    makeMessage(runId + "-user", offset + 1, { role: "user", runId }),
    makeMessage(runId + "-call", offset + 2, {
      runId,
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: runId + "-tool", name: "read", arguments: {} }],
    }),
    makeMessage(runId + "-result", offset + 3, {
      role: "toolResult",
      runId,
      toolCallId: runId + "-tool",
      toolName: "read",
      content: "Read completed.",
    }),
  ];
}
let nextSession = 0;
function fixture(messages: unknown[], activeRunIds: string[], localRunId: string | null = null) {
  const sessionKey = "background-proof-" + nextSession++;
  const runId = resolveChatProjectionRunId({ localRunId, activeRunIds, queue: [] });
  const items = buildChatItems(
    createProps({
      sessionKey,
      messages,
      runId,
      runActive: activeRunIds.length > 0,
      runWorking: activeRunIds.length > 0,
      streamStartedAt: 1,
      showToolCalls: true,
    }),
  );
  const options = {
    sessionKey,
    messages,
    activeRunId: runId,
    activeRunIds,
    runWorking: activeRunIds.length > 0,
    searchActive: false,
  };
  return { items, options, runId, chain: projectTranscriptChain(items, options) };
}
const frames = (chain: ReturnType<typeof projectTranscriptChain>) =>
  chain.transcriptItems.filter((item) => item.kind === "agent-run-frame");

describe("background run lifecycle projection", () => {
  it.each([false, true])(
    "keeps an active tool run without a local send, compaction=%s",
    (compaction) => {
      const messages = toolRun("background");
      if (compaction) {
        messages.unshift(
          makeMessage("compaction", 1, {
            role: "system",
            __openclaw: {
              id: "compaction",
              kind: "compaction",
              tokensBefore: 251440,
              tokensAfter: 67702,
            },
          }),
        );
      }
      const result = fixture(messages, ["background"]);
      expect(result.runId).toBeNull();
      expect(frames(result.chain)).toMatchObject([
        { runId: "background", outcome: { kind: "active" } },
      ]);
      // Session membership must not invent ownership for the independent live stream.
      expect(
        result.chain.transcriptItems.find((item) => item.kind === "stream-run")?.runId,
      ).toBeUndefined();
    },
  );

  it("tracks all active runs without assigning a foreground or reviving unrelated work", () => {
    const messages = [...toolRun("one"), ...toolRun("two", 10), ...toolRun("old", 20)];
    const result = fixture(messages, ["two", "one"]);
    expect(result.runId).toBeNull();
    expect(frames(result.chain).map((frame) => [frame.runId, frame.outcome.kind])).toEqual([
      ["one", "active"],
      ["two", "active"],
      ["old", "completed"],
    ]);
  });

  it.each([
    {
      name: "canonical empty final",
      fields: {
        content: [],
        stopReason: "toolUse",
        __openclaw: { runId: "background", runTerminal: true },
      },
    },
    { name: "silent stop", fields: { content: [], stopReason: "stop" } },
    { name: "explicit final answer", fields: { content: "Done.", phase: "final_answer" } },
    { name: "error", fields: { content: [], stopReason: "error" } },
    { name: "abort metadata", fields: { content: [], openclawAbort: { aborted: true } } },
  ])("does not revive $name from a stale active list", ({ fields }) => {
    const terminal = makeMessage("terminal", 4, { runId: "background", ...fields });
    const result = fixture([...toolRun("background"), terminal], ["background"]);
    expect(frames(result.chain)).toHaveLength(1);
    expect(frames(result.chain).every((frame) => frame.outcome.kind !== "active")).toBe(true);
  });

  it.each([undefined, "aborted", "error", "timeout"] as const)(
    "honors a live terminal with disposition %s",
    (disposition) => {
      const terminal = rememberLiveTerminalRun(
        makeMessage("terminal", 4, {
          runId: "background",
          content: [],
          stopReason: "toolUse",
        }),
        "background",
        disposition,
      );
      const result = fixture([...toolRun("background"), terminal], ["background"]);
      expect(frames(result.chain)).toHaveLength(1);
      expect(frames(result.chain).every((frame) => frame.outcome.kind !== "active")).toBe(true);
    },
  );

  it.each([
    { name: "commentary", fields: { phase: "commentary" } },
    {
      name: "keyed stream",
      fields: { openclawStreamFallback: { itemId: "progress", source: "segment" } },
    },
    {
      name: "reasoning mirror",
      fields: { __openclaw: { runId: "background", mirrorOrigin: "codex-app-server" } },
    },
    {
      name: "provider speech",
      fields: { __openclaw: { runId: "background", voiceTranscript: "provider-owned" } },
    },
  ])("does not mistake stopped $name for a terminal", ({ fields }) => {
    const progress = makeMessage("progress", 1, {
      runId: "background",
      stopReason: "stop",
      ...fields,
    });
    const result = fixture([progress, ...toolRun("background", 1)], ["background"]);
    expect(frames(result.chain).length).toBeGreaterThan(0);
    expect(
      frames(result.chain)
        .filter((frame) => frame.runId === "background")
        .every((frame) => frame.outcome.kind === "active"),
    ).toBe(true);
  });

  it("invalidates cached frames when only active membership changes", () => {
    const messages = [...toolRun("one"), ...toolRun("two", 10)];
    const result = fixture(messages, ["one"]);
    const first = frames(result.chain);
    const activeRunIds = result.options.activeRunIds;
    activeRunIds.splice(0, 1, "two");
    const second = frames(projectTranscriptChain(result.items, result.options));
    expect(first.map((frame) => frame.outcome.kind)).toEqual(["active", "completed"]);
    expect(second.map((frame) => frame.outcome.kind)).toEqual(["completed", "active"]);
    expect(second.map((frame) => frame.key)).toEqual(first.map((frame) => frame.key));
    activeRunIds.length = 0;
    expect(
      frames(projectTranscriptChain(result.items, result.options)).map(
        (frame) => frame.outcome.kind,
      ),
    ).toEqual(["completed", "completed"]);
  });
});

describe("self-woken continuation projection", () => {
  const row = (id: string, seq: number, runId: string, fields: Record<string, unknown> = {}) =>
    makeMessage(id, seq, { runId, timestamp: seq * 60_000, ...fields });
  const wake = (source: string, seq: number, runId: string) =>
    row(`${runId}-call`, seq, runId, {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: `${runId}-tool`, name: "exec", arguments: {} }],
      __openclaw: {
        id: `${runId}-call`,
        seq,
        runId,
        ...(source === "subagent" ? {} : { turnBoundary: true }),
        continuation: { source },
      },
    });
  const result = (seq: number, runId: string) =>
    row(`${runId}-result`, seq, runId, {
      role: "toolResult",
      toolCallId: `${runId}-tool`,
      toolName: "exec",
      content: "done",
    });

  it("continues the answered block below a Resumed rule per wake, until the next prompt", () => {
    const sessionKey = "agent:main:dashboard:continuation";
    const messages = [
      row("ask", 1, "ask", { role: "user", content: "Review the change" }),
      row("answer", 2, "ask", { content: "Long final answer", stopReason: "stop" }),
      wake("exec", 3, "late"),
      result(4, "late"),
      wake("subagent", 5, "settle"),
      result(6, "settle"),
      row("settled", 7, "settle", { content: "Child finished; all good.", stopReason: "stop" }),
      row("next", 8, "next", { role: "user", content: "Thanks" }),
      row("reply", 9, "next", { content: "Anytime.", stopReason: "stop" }),
    ];
    const items = buildChatItems(createProps({ sessionKey, messages, showToolCalls: true }));
    const chain = projectTranscriptChain(items, {
      sessionKey,
      messages,
      runWorking: false,
      searchActive: false,
    });
    const [first, second, ...rest] = frames(chain);
    expect(rest).toEqual([]);
    // One block per prompt; the earlier answer stays visible in place.
    expect(first!.parts.map((part) => [part.kind, chatItemGroups(part)[0]?.runId])).toEqual([
      ["group", "ask"],
      ["activity-run", "late"],
      ["activity-run", "settle"],
      ["group", "settle"],
    ]);
    expect(
      first!.parts.map((part) =>
        readProjectedContinuation(chatItemGroups(part)[0]?.messages[0]?.message),
      ),
    ).toEqual([undefined, "exec", "subagent", undefined]);
    expect(second!.runId).toBe("next");
  });

  it("keeps the Resumed rule when tool calls hide the row that carries it", () => {
    const sessionKey = "agent:main:dashboard:continuation-hidden-tools";
    const messages = [
      row("ask", 1, "ask", { role: "user", content: "Review the change" }),
      row("answer", 2, "ask", { content: "Long final answer", stopReason: "stop" }),
      wake("exec", 3, "late"),
      result(4, "late"),
      row("late-answer", 5, "late", { content: "Command finished.", stopReason: "stop" }),
    ];
    const items = buildChatItems(createProps({ sessionKey, messages, showToolCalls: false }));
    const chain = projectTranscriptChain(items, {
      sessionKey,
      messages,
      runWorking: false,
      searchActive: false,
    });
    const [first, ...rest] = frames(chain);
    expect(rest).toEqual([]);
    // The hidden tool row stays as the part that opens with the Resumed rule.
    expect(
      first!.parts.map((part) =>
        readProjectedContinuation(chatItemGroups(part)[0]?.messages[0]?.message),
      ),
    ).toEqual([undefined, "exec", undefined]);
  });

  it("keeps a settle wake's completion receipt in the answered block", () => {
    const completion = { runId: "child", sessionKey: "agent:main:subagent:w", label: "W" };
    const messages = [
      row("ask", 1, "ask", { role: "user", content: "Review the change" }),
      row("answer", 2, "ask", { content: "Long final answer", stopReason: "stop" }),
      row("receipt", 3, "settle", {
        phase: "commentary",
        content: [{ type: "subagent_completion" }],
        subagentCompletions: [completion],
        __openclaw: {
          id: "receipt",
          seq: 3,
          runId: "settle",
          continuation: { source: "subagent" },
        },
      }),
      row("settled", 4, "settle", { content: "W finished; all good.", stopReason: "stop" }),
    ];
    for (const showToolCalls of [true, false]) {
      const sessionKey = `agent:main:dashboard:settle-receipt-${showToolCalls}`;
      const items = buildChatItems(createProps({ sessionKey, messages, showToolCalls }));
      const chain = projectTranscriptChain(items, {
        sessionKey,
        messages,
        runWorking: false,
        searchActive: false,
      });
      const [first, ...rest] = frames(chain);
      expect(rest).toEqual([]);
      expect(
        first!.parts.map((part) =>
          readProjectedContinuation(chatItemGroups(part)[0]?.messages[0]?.message),
        ),
      ).toContain("subagent");
    }
  });
});
