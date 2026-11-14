import { describe, expect, it } from "vitest";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { pendingSessionsYield } from "../chat-sessions-yield.ts";
import { buildChatItems, type BuildChatItemsProps } from "../chat-thread-build.ts";
import { createProps, makeMessage } from "../chat-thread.test-support.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
import { projectTranscriptChain } from "./chat-transcript-message-index.ts";

const sessionKey = "agent:main:dashboard:0f6d5a1c-5a9e-4c1e-9b1a-2f3c4d5e6f70";

const chatItems = (overrides: Partial<BuildChatItemsProps>) =>
  buildChatItems(createProps({ sessionKey, ...overrides }));
type Chain = ReturnType<typeof projectTranscriptChain>;
type ChainOptions = Partial<Parameters<typeof projectTranscriptChain>[1]>;
function chainFor(items: Parameters<typeof projectTranscriptChain>[0], options: ChainOptions = {}) {
  return projectTranscriptChain(items, {
    sessionKey,
    runWorking: false,
    searchActive: false,
    ...options,
  });
}
function projectHistory(
  messages: unknown[],
  options: Partial<BuildChatItemsProps> & ChainOptions = {},
) {
  return chainFor(chatItems({ messages, ...options }), options);
}
const framesOf = (chain: Chain) =>
  chain.transcriptItems.filter((item) => item.kind === "agent-run-frame");
const messagesIn = (items: readonly Parameters<typeof chatItemGroups>[0][]) =>
  items.flatMap(chatItemGroups).flatMap((group) => group.messages.map(({ message }) => message));

describe("PR preparation handoff", () => {
  const prepareCall = {
    type: "toolCall",
    id: "prepare-call",
    name: "github_publish",
    arguments: { action: "prepare_pr", pullRequestUrl: "https://github.com/example/app/pull/1" },
  };
  const receipt = { status: "started", async: true, yielded: true };
  const messages = [
    makeMessage("prepare-request", 1, {
      role: "user",
      runId: "prepare-run",
      content: "Prepare my PR.",
      timestamp: 1_000,
    }),
    {
      role: "assistant",
      runId: "prepare-run",
      timestamp: 2_000,
      stopReason: "toolUse",
      content: [{ type: "text", text: "Preparing your PR." }, prepareCall],
    },
    {
      role: "toolResult",
      runId: "prepare-run",
      timestamp: 2_001,
      toolCallId: "prepare-call",
      toolName: "github_publish",
      content: [{ type: "text", text: JSON.stringify(receipt) }],
    },
    {
      role: "user",
      runId: "resume-run",
      timestamp: 3_000,
      provenance: { kind: "internal_system", sourceTool: "plugin" },
      content:
        '[System] PR preparation result: {"status":"prepared","url":"https://github.com/example/app/pull/1"}',
    },
    {
      role: "assistant",
      runId: "resume-run",
      timestamp: 4_000,
      stopReason: "stop",
      content: "Your PR is ready for work.",
    },
  ];

  it.each(
    [false, true].flatMap((showToolCalls) =>
      ["direct", "nested", "live"].map((source) => ({ showToolCalls, source })),
    ),
  )(
    "preserves preparation chronology ($source, showToolCalls=$showToolCalls)",
    ({ source, showToolCalls }) => {
      const entries =
        source === "nested"
          ? [
              messages[0],
              {
                ...messages[1],
                content: [
                  { type: "text", text: "Preparing your PR." },
                  { type: "toolCall", id: "exec-call", name: "exec", arguments: {} },
                ],
              },
              {
                role: "custom",
                customType: "openclaw.nested-tool.v1",
                runId: "prepare-run",
                timestamp: 2_001,
                content: [
                  { ...prepareCall, parentToolCallId: "exec-call" },
                  {
                    type: "toolResult",
                    toolCallId: "prepare-call",
                    name: "github_publish",
                    parentToolCallId: "exec-call",
                    details: receipt,
                  },
                ],
              },
              ...messages.slice(3),
            ]
          : messages;
      const toolMessages =
        source === "live"
          ? [
              {
                ...entries[2],
                __openclawToolStreamLive: true,
                __openclawToolStreamResultReceived: true,
              },
            ]
          : [];
      const persisted = source === "live" ? [...entries.slice(0, 2), ...entries.slice(3)] : entries;
      const chain = projectHistory(persisted, { messages: persisted, toolMessages, showToolCalls });
      const frames = framesOf(chain);
      expect(frames.map((frame) => [frame.runId, frame.outcome.kind])).toEqual([
        ["prepare-run", "completed"],
        ["resume-run", "completed"],
      ]);
      expect(chain.transcriptItems.map((item) => item.kind)).toEqual([
        "group",
        "agent-run-frame",
        "notice",
        "agent-run-frame",
      ]);
      expect(chain.transcriptItems[2]).toMatchObject({
        label: "System",
        startsTurn: true,
        timestamp: 3_000,
        text: 'PR preparation result: {"status":"prepared","url":"https://github.com/example/app/pull/1"}',
      });
      if (showToolCalls) {
        expect(JSON.stringify(frames[0])).toContain("prepare_pr");
        expect(JSON.stringify(frames[0])).toContain("https://github.com/example/app/pull/1");
      } else {
        expect(JSON.stringify(frames[0])).not.toContain("prepare_pr");
        expect(JSON.stringify(frames[0])).not.toContain("https://github.com/example/app/pull/1");
      }
      // Preparation is not a private child wait and must not change its consumers.
      expect(pendingSessionsYield(entries.slice(0, 3))).toBeNull();
    },
  );

  it.each([
    { name: "deferred", details: { status: "deferred" } },
    { name: "not yielded", details: { status: "started", async: true } },
    { name: "not async", details: { status: "started", yielded: true } },
    { name: "failed result", details: receipt, isError: true },
    { name: "unpaired result", details: receipt, unpaired: true },
    {
      name: "a synchronous publish result with tools hidden",
      details: { status: "published" },
      action: "publish",
      showToolCalls: false,
    },
  ])(
    "does not infer a handoff from $name",
    ({ details, isError, unpaired, action, showToolCalls = true }) => {
      const entries = [
        messages[0],
        {
          ...messages[1],
          content: unpaired
            ? [{ type: "text", text: "Preparing your PR." }]
            : [
                { type: "text", text: "Preparing your PR." },
                {
                  ...prepareCall,
                  arguments: { ...prepareCall.arguments, action: action ?? "prepare_pr" },
                },
              ],
        },
        {
          ...messages[2],
          details,
          isError,
          content: [{ type: "text", text: JSON.stringify(details) }],
        },
        ...messages.slice(3),
      ];
      const frame = framesOf(projectHistory(entries, { messages: entries, showToolCalls }))[0];
      expect(frame?.outcome.kind).toBe("interrupted");
      if (!showToolCalls) {
        expect(JSON.stringify(messagesIn([frame!]))).not.toContain("yielded");
      }
    },
  );

  it.each(["aborted", "error", "timeout", "live-abort"])(
    "preserves an actual %s after handoff",
    (reason) => {
      const terminal = {
        role: "assistant",
        runId: "prepare-run",
        timestamp: 2_100,
        content: "Preparation stopped.",
        ...(reason === "live-abort" ? {} : { stopReason: reason }),
      };
      if (reason === "live-abort") {
        rememberLiveTerminalRun(terminal, "prepare-run", "aborted");
      }
      const entries = [...messages.slice(0, 3), terminal, ...messages.slice(3)];
      expect(framesOf(projectHistory(entries, { messages: entries }))[0]?.outcome.kind).toBe(
        "failed",
      );
    },
  );

  it("does not merge later human input or borrow its live status", () => {
    const later = makeMessage("A different request.", 6, {
      role: "user",
      runId: "later-run",
      timestamp: 5_000,
    });
    const entries = [...messages.slice(0, 3), later];
    const props = {
      messages: entries,
      runId: "later-run",
      runActive: true,
      runWorking: true,
      streamStartedAt: 6_000,
    };
    const items = chatItems(props);
    expect(items.find((item) => item.kind === "reading-indicator")).toMatchObject({
      runId: "later-run",
      startedAt: 6_000,
    });
    expect(items.find((item) => item.kind === "reading-indicator")).not.toHaveProperty("request");
    const chain = chainFor(items, props);
    expect(framesOf(chain).map((frame) => [frame.runId, frame.outcome.kind])).toEqual([
      ["prepare-run", "completed"],
      ["later-run", "active"],
    ]);
    expect(chain.transcriptItems.at(-2)).toMatchObject({ kind: "group", role: "user" });
  });
});

describe("workspace publication handoff", () => {
  const publishCall = {
    type: "toolCall",
    id: "publish-call",
    name: "github_publish",
    arguments: { action: "publish", workspacePath: "/work/app" },
  };
  const report =
    "Published example/app branch fix/menus: https://github.com/example/app/pull/2 Using @bot (Agent override).";
  const messages = [
    makeMessage("publish-request", 1, {
      role: "user",
      runId: "publish-run",
      content: "Publish my fix.",
      timestamp: 1_000,
    }),
    {
      role: "assistant",
      runId: "publish-run",
      timestamp: 2_000,
      stopReason: "toolUse",
      content: [publishCall],
    },
    {
      role: "toolResult",
      runId: "publish-run",
      timestamp: 2_001,
      toolCallId: "publish-call",
      toolName: "github_publish",
      content: [
        { type: "text", text: JSON.stringify({ status: "started", async: true, yielded: true }) },
      ],
    },
    // The Gateway reports the result without a run; the next run resumes after it.
    {
      role: "assistant",
      timestamp: 3_000,
      stopReason: "stop",
      model: "gateway-publication",
      content: [{ type: "text", text: report }],
    },
    {
      role: "assistant",
      runId: "resume-run",
      timestamp: 4_000,
      stopReason: "stop",
      content: "The PR is green.",
    },
  ];

  it("continues one answer through its result report", () => {
    const chain = projectHistory(messages, { messages });
    expect(chain.transcriptItems.map((item) => item.kind)).toEqual(["group", "agent-run-frame"]);
    const [frame] = framesOf(chain);
    expect(frame?.outcome.kind).toBe("completed");
    expect(JSON.stringify(messagesIn([frame!]))).toContain(report);
    expect(JSON.stringify(messagesIn([frame!]))).toContain("The PR is green.");
  });

  it("does not mark a handoff awaiting its continuation as interrupted", () => {
    const entries = messages.slice(0, 4);
    const frames = framesOf(projectHistory(entries, { messages: entries }));
    expect(frames.map((frame) => frame.outcome.kind)).toEqual(["completed"]);
    expect(JSON.stringify(messagesIn(frames))).toContain(report);
  });
});
