import { describe, expect, it } from "vitest";
import { chatItemGroups } from "../chat-agent-run-grouping.ts";
import { pendingSessionsYield } from "../chat-sessions-yield.ts";
import { buildChatItems, type BuildChatItemsProps } from "../chat-thread-build.ts";
import { createProps, makeMessage } from "../chat-thread.test-support.ts";
import { rememberLiveTerminalRun } from "../terminal-message-identity.ts";
import { projectTranscriptChain, projectTranscriptIndex } from "./chat-transcript-message-index.ts";

const sessionKey = "agent:main:dashboard:0f6d5a1c-5a9e-4c1e-9b1a-2f3c4d5e6f70";
const abortedSession = (lastRunId: string) => ({
  key: sessionKey,
  lastRunId,
  abortedLastRun: true,
});

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

describe("tool media and operation receipts", () => {
  it.each([
    { label: "published", text: "Published example/app: https://github.com/example/app/pull/1" },
    { label: "failed", text: "Publication failed. Reconnect GitHub." },
  ])("preserves a delayed $label report even without a subsequent answer", ({ text }) => {
    for (const answered of [false, true]) {
      const report = makeMessage("late-report", 3, {
        role: "assistant",
        runId: "publish-run",
        provider: "openclaw",
        model: "gateway-publication",
        stopReason: "stop",
        content: text,
      });
      const messages = [
        makeMessage("request", 1, { role: "user", runId: "publish-run", content: "Publish this." }),
        ...(answered
          ? [
              makeMessage("answer", 2, {
                role: "assistant",
                runId: "publish-run",
                phase: "final_answer",
                stopReason: "stop",
                content: "Publication has started.",
              }),
            ]
          : []),
        report,
      ];
      for (const history of [messages, structuredClone(messages)]) {
        const chain = projectHistory(history, { messages: history, persistCommentary: false });
        const visible = chain.transcriptItems.flatMap((item) =>
          item.kind === "agent-run-frame"
            ? item.parts.filter((part) => part.kind === "group")
            : item.kind === "group"
              ? [item]
              : [],
        );
        expect(messagesIn(visible)).toContainEqual(report);
      }
    }
  });

  it.each([0, 150, 300])(
    "keeps a completed media reply together after %s earlier turns",
    (earlierTurns) => {
      const earlier = Array.from({ length: earlierTurns }, (_, index) => [
        makeMessage("prior-request-" + index, index * 2, {
          role: "user",
          content: "Earlier request",
          runId: "prior-" + index,
        }),
        makeMessage("prior-answer-" + index, index * 2 + 1, {
          role: "assistant",
          content: "Earlier answer",
          stopReason: "stop",
          runId: "prior-" + index,
        }),
      ]).flat();
      let seq = earlier.length;
      const entry = (id: string, message: Record<string, unknown>) =>
        makeMessage(id, ++seq, { runId: "media-run", ...message });
      const inspect = (id: string) => [
        entry(id, {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id, name: "view_image", arguments: {} }],
        }),
        entry(id + "-result", {
          role: "toolResult",
          toolCallId: id,
          toolName: "view_image",
          content: [
            { type: "image", artifactId: id + "-image", omitted: true, mimeType: "image/png" },
          ],
        }),
      ];
      const active = [
        ...earlier,
        entry("request", { role: "user", content: "Check both screenshots." }),
        ...Array.from({ length: 40 }, (_, index) =>
          entry("read-" + index, {
            role: "toolResult",
            toolCallId: "read-" + index,
            toolName: "read",
            content: "Checked source file.",
          }),
        ),
        ...inspect("before"),
        entry("receipt", {
          role: "assistant",
          stopReason: "stop",
          content: "Published preview.",
          provider: "openclaw",
          model: "gateway-publication",
        }),
        ...inspect("after"),
      ];
      const answer = entry("answer", {
        role: "assistant",
        phase: "final_answer",
        stopReason: "stop",
        content: [
          { type: "text", text: "Verified preview." },
          { type: "image", artifactId: "delivered-image", omitted: true, mimeType: "image/png" },
        ],
      });
      const working = framesOf(
        projectHistory(active, {
          messages: active,
          runWorking: true,
          activeRunId: "media-run",
          runId: "media-run",
        }),
      ).at(-1)!;
      expect(working.outcome.kind).toBe("active");
      for (const messages of [[...active, answer], structuredClone([...active, answer])]) {
        const chain = projectHistory(messages, { messages });
        const frame = framesOf(chain).at(-1)!;
        expect(frame.outcome.kind).toBe("completed");
        expect(frame.parts.map((part) => part.kind)).toEqual(["work-group", "group"]);
        expect(JSON.stringify(messagesIn([frame.parts[0]!]))).toContain("before-image");
        expect(JSON.stringify(messagesIn([frame.parts[0]!]))).toContain("after-image");
        expect(JSON.stringify(messagesIn([frame.parts[1]!]))).toContain("delivered-image");
        const rows = projectTranscriptIndex(chain, new Map(), {
          assistantName: "Agent",
          currentAgentId: "main",
        }).rows.filter(
          (row) =>
            row.kind === "item" &&
            row.item.kind === "agent-run-frame" &&
            row.item.runId === "media-run",
        );
        expect(rows).toHaveLength(earlierTurns ? 2 : 1);
      }
    },
  );
});

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
      const options = { messages: entries, showToolCalls, session: abortedSession("prepare-run") };
      const frame = framesOf(projectHistory(entries, options))[0];
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
    "Published example/app branch fix/menus: https://github.com/example/app/pull/2 Using @bot (Own account).";
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

describe("background media handoff", () => {
  const receipt = { status: "started", async: true, taskId: "media-task", runId: "media-task" };
  function mediaHistory(name: string, details: unknown = receipt, isError = false) {
    return [
      makeMessage("media-request", 1, {
        role: "user",
        runId: "media-run",
        content: "Revise the poster.",
      }),
      {
        role: "assistant",
        runId: "media-run",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Revising the poster." },
          { type: "toolCall", id: "media-call", name, arguments: { prompt: "Pixel poster" } },
        ],
      },
      {
        role: "toolResult",
        runId: "media-run",
        toolCallId: "media-call",
        toolName: name,
        details,
        isError,
        content: [{ type: "text", text: JSON.stringify(details) }],
      },
    ];
  }

  it.each(["image_generate", "video_generate", "music_generate"])(
    "recognizes accepted %s without inventing a child-session wait",
    (name) => {
      const messages = mediaHistory(name);
      for (const live of [false, true]) {
        const persisted = live ? messages.slice(0, 2) : messages;
        const toolMessages = live
          ? [
              {
                ...messages[2],
                __openclawToolStreamLive: true,
                __openclawToolStreamResultReceived: true,
              },
            ]
          : [];
        for (const showToolCalls of [false, true]) {
          const chain = projectHistory(persisted, {
            messages: persisted,
            toolMessages,
            showToolCalls,
          });
          expect(framesOf(chain).map((frame) => frame.outcome.kind)).toEqual(["completed"]);
          expect(JSON.stringify(messagesIn(framesOf(chain)))).toContain("Revising the poster.");
          if (!showToolCalls) {
            expect(JSON.stringify(chain.transcriptItems)).not.toContain(name);
          }
        }
      }
      expect(pendingSessionsYield(messages)).toBeNull();
    },
  );

  it.each([
    { name: "failed receipt", details: receipt, isError: true },
    { name: "synchronous result", details: { status: "completed" } },
    { name: "missing task identity", details: { status: "started", async: true } },
    { name: "unrelated tool", details: receipt, tool: "exec" },
  ])("does not hide an unfinished run with $name", ({ details, isError, tool }) => {
    const messages = mediaHistory(tool ?? "image_generate", details, isError);
    const chain = projectHistory(messages, { messages, session: abortedSession("media-run") });
    expect(framesOf(chain)[0]?.outcome.kind).toBe("interrupted");
  });

  it.each(["aborted", "error", "timeout"])("preserves a real %s after acceptance", (stopReason) => {
    const messages = [
      ...mediaHistory("image_generate"),
      { role: "assistant", runId: "media-run", stopReason, content: "Generation stopped." },
    ];
    expect(framesOf(projectHistory(messages, { messages }))[0]?.outcome.kind).toBe("failed");
  });
});
