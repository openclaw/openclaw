import { describe, expect, it } from "vitest";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { pendingSessionsYield } from "../chat-sessions-yield.ts";
import { buildChatItems, type BuildChatItemsProps } from "../chat-thread-build.ts";
import {
  message as historyMessage,
  nativeMessage,
  text,
} from "../chat-thread-fixtures.test-support.ts";
import { createProps } from "../chat-thread.test-support.ts";
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
  const prUrl = "https://github.com/example/app/pull/1";
  const prepareCall = {
    type: "toolCall",
    id: "prepare-call",
    name: "github_publish",
    arguments: { action: "prepare_pr", pullRequestUrl: prUrl },
  };
  const receipt = { status: "started", async: true, yielded: true };
  const preparing = text("Preparing your PR.");
  const ready = `PR preparation result: ${JSON.stringify({ status: "prepared", url: prUrl })}`;
  const preparedMessage = (role: string, content: unknown, timestamp: number, extra = {}) =>
    historyMessage(role, content, timestamp, { runId: "prepare-run", ...extra });
  const messages = [
    nativeMessage("user", "Prepare my PR.", 1_000, {
      id: "prepare-request",
      seq: 1,
      runId: "prepare-run",
    }),
    preparedMessage("assistant", [preparing, prepareCall], 2_000, { stopReason: "toolUse" }),
    preparedMessage("toolResult", [text(JSON.stringify(receipt))], 2_001, {
      toolCallId: "prepare-call",
      toolName: "github_publish",
    }),
    historyMessage("user", `[System] ${ready}`, 3_000, {
      runId: "resume-run",
      provenance: { kind: "internal_system", sourceTool: "plugin" },
    }),
    historyMessage("assistant", "Your PR is ready for work.", 4_000, {
      runId: "resume-run",
      stopReason: "stop",
    }),
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
                  preparing,
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
      const chain = projectHistory(persisted, { toolMessages, showToolCalls });
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
        text: ready,
      });
      for (const detail of ["prepare_pr", prUrl]) {
        expect(JSON.stringify(frames[0]).includes(detail)).toBe(showToolCalls);
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
            ? [preparing]
            : [
                preparing,
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
          content: [text(JSON.stringify(details))],
        },
        ...messages.slice(3),
      ];
      const frame = framesOf(projectHistory(entries, { showToolCalls }))[0];
      expect(frame?.outcome.kind).toBe("interrupted");
      if (!showToolCalls) {
        expect(JSON.stringify(messagesIn([frame!]))).not.toContain("yielded");
      }
    },
  );

  it.each(["aborted", "error", "timeout", "live-abort"])(
    "preserves an actual %s after handoff",
    (reason) => {
      const terminal = preparedMessage(
        "assistant",
        "Preparation stopped.",
        2_100,
        reason === "live-abort" ? {} : { stopReason: reason },
      );
      if (reason === "live-abort") {
        rememberLiveTerminalRun(terminal, "prepare-run", "aborted");
      }
      const entries = [...messages.slice(0, 3), terminal, ...messages.slice(3)];
      expect(framesOf(projectHistory(entries))[0]?.outcome.kind).toBe("failed");
    },
  );
});
