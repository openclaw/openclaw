import { describe, expect, it } from "vitest";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { pendingSessionsYield } from "../chat-sessions-yield.ts";
import { buildChatItems, type BuildChatItemsProps } from "../chat-thread-build.ts";
import { createProps } from "../chat-thread.test-support.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
import { projectTranscriptChain } from "./chat-transcript-message-index.ts";

const sessionKey = "agent:main:dashboard:0f6d5a1c-5a9e-4c1e-9b1a-2f3c4d5e6f70";
function makeMessage(
  id: string,
  seq: number,
  fields: { role?: string; timestamp?: number; runId?: string; [key: string]: unknown } = {},
) {
  const { role = "assistant", timestamp = seq * 10, runId = "run-1", ...extra } = fields;
  return { role, content: id, timestamp, __openclaw: { id, seq, runId }, ...extra };
}
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
    { name: "another action", details: receipt, action: "publish" },
    {
      name: "another action with tools hidden",
      details: receipt,
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
