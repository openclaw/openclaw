// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import {
  emptyAssistantAcknowledgment,
  emptyAssistantHistory,
} from "../../test-helpers/empty-assistant-history.ts";
import { resetWorkingProgress, resolveTurnRecap } from "./chat-progress.ts";
import { pendingSessionsYield, readHandoffDisplay } from "./chat-sessions-yield.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { projectTranscriptActivity } from "./components/chat-transcript-activity.ts";

const call = {
  type: "toolCall",
  id: "yield-call",
  name: "sessions_yield",
  arguments: {},
};
const result = {
  type: "toolResult",
  toolCallId: "yield-call",
  name: "sessions_yield",
  content: [{ type: "text", text: '{"status":"yielded"}' }],
};
const separateHistory = [
  { role: "assistant", runId: "parent-run", timestamp: 2_000, content: [call] },
  {
    role: "toolResult",
    runId: "parent-run",
    timestamp: 2_001,
    toolCallId: "yield-call",
    toolName: "sessions_yield",
    content: result.content,
  },
];
const nestedHistory = [
  {
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    runId: "parent-run",
    timestamp: 2_000,
    content: [
      { ...call, parentToolCallId: "exec-call" },
      { ...result, parentToolCallId: "exec-call" },
    ],
  },
];
const yieldRequest = (args: Record<string, unknown>, before: unknown[] = []) => ({
  ...separateHistory[0],
  content: [...before, { ...call, arguments: args }],
});
const handoffRun = (runId: string, delay: number) =>
  separateHistory.map((message) => ({ ...message, runId, timestamp: message.timestamp + delay }));
const pendingHandoff = { timestamp: 2_000, runId: "parent-run" };
// A confirmed handoff leaves one structural item behind and nothing to draw.
const silentBoundary = expect.objectContaining({ kind: "notice", handoffBoundary: true, text: "" });
const waitingNotice = expect.objectContaining({ kind: "notice", text: "Waiting for a message" });

const projectHistory = (messages: unknown[], props: Parameters<typeof createProps>[0] = {}) =>
  buildChatItems(createProps({ messages, ...props }));
type Items = ReturnType<typeof projectHistory>;
const transcriptMessages = (items: Items) =>
  items.flatMap((item) => (item.kind === "group" ? item.messages : []));
const transcriptTools = (items: Items) =>
  transcriptMessages(items).flatMap(({ message }) => extractToolCardsCached(message));
const handoffDisplays = (items: Items) =>
  transcriptMessages(items)
    .map(({ message }) => readHandoffDisplay(message))
    .filter(Boolean);
function withYieldResult(
  content: typeof result.content,
  fields: { details?: unknown; isError?: boolean } = {},
) {
  return [separateHistory[0], { ...separateHistory[1], content, ...fields }];
}

describe("sessions_yield transcript projection", () => {
  it.each([
    ["separate tool result", separateHistory],
    ["nested exec activity", nestedHistory],
  ])("leaves no transcript row for %s and reports the pending handoff", (_name, messages) => {
    const original = structuredClone(messages);
    expect(projectHistory(messages, { showToolCalls: false })).toEqual([silentBoundary]);
    expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
    expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
    expect(messages).toEqual(original);
  });

  it.each([false, true])(
    "never displays private yield inputs before confirmation (failed=%s)",
    (failed) => {
      const messages = [
        yieldRequest({ message: "PRIVATE_PENDING_CONTEXT" }),
        ...(failed
          ? [
              {
                ...separateHistory[1],
                isError: true,
                content: [{ type: "text", text: "Yield rejected" }],
              },
            ]
          : []),
      ];
      const original = structuredClone(messages);
      const items = projectHistory(messages, { showToolCalls: true });
      expect(JSON.stringify(items)).not.toContain("PRIVATE_PENDING_CONTEXT");
      expect(pendingSessionsYield(messages)).toBeNull();
      if (failed) {
        expect(JSON.stringify(items)).toContain("Yield rejected");
      }
      expect(messages).toEqual(original);
    },
  );

  it("keeps a nested handoff pending when its exec wrapper completes in the same run", () => {
    const messages = [
      ...nestedHistory,
      {
        role: "assistant",
        runId: "parent-run",
        timestamp: 2_010,
        content: [
          { type: "toolCall", id: "exec-call", name: "exec", arguments: {} },
          {
            type: "toolResult",
            toolCallId: "exec-call",
            name: "exec",
            content: [{ type: "text", text: "Done" }],
          },
        ],
      },
    ];
    expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
  });

  it("preserves sibling tools and prose without displaying private yield arguments", () => {
    const messages = [
      {
        role: "assistant",
        timestamp: 2_000,
        content: [
          { type: "text", text: "Delegated implementation." },
          { type: "toolCall", id: "read-call", name: "read", arguments: { path: "README.md" } },
          { ...call, arguments: { message: "PRIVATE_CONTINUATION" } },
          result,
        ],
      },
    ];
    const items = projectHistory(messages);
    expect(items.filter((item) => item.kind === "notice")).toEqual([silentBoundary]);
    expect(transcriptTools(items).map((card) => card.name)).toEqual(["read"]);
    expect(JSON.stringify(items)).toContain("Delegated implementation.");
    expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
    const hidden = projectHistory(messages, { showToolCalls: false });
    expect(transcriptTools(hidden)).toEqual([]);
    expect(JSON.stringify(hidden)).toContain("Delegated implementation.");
  });

  it("requires a successful call/result pair", () => {
    const messages = [separateHistory[1]!];
    expect(pendingSessionsYield(messages)).toBeNull();
    expect(projectHistory(messages, { showToolCalls: false })).toEqual([]);
  });

  it("reads a leading receipt with annotations without changing its public acknowledgment", () => {
    const acknowledgment = 'I’ll check {docs} and the "CLI".\nThen report back.';
    const messages = withYieldResult(
      [
        {
          type: "text",
          text: " \n" + JSON.stringify({ status: "yielded", acknowledgment }, null, 2),
        },
        { type: "text", text: "The session will resume when its children finish." },
      ],
      { details: { display: "Yield" } },
    );
    const items = projectHistory(messages);
    expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
    expect(items).toContainEqual(silentBoundary);
    expect(groupTexts(items)).toEqual([expect.stringContaining(JSON.stringify(acknowledgment))]);
    expect(JSON.stringify(items)).not.toContain("The session will resume");
  });

  it.each([
    { name: "malformed primary object", output: '{"status":"yielded",}\n{"status":"yielded"}' },
    { name: "unterminated primary object", output: '{"status":"yielded"\n{"status":"yielded"}' },
    { name: "nonleading object", output: 'Example receipt: {"status":"yielded"}' },
    { name: "array wrapper", output: '[{"status":"yielded"}]' },
    { name: "deferred primary receipt", output: '{"status":"deferred"}\n{"status":"yielded"}' },
    { name: "error-flagged receipt", output: '{"status":"yielded"}', isError: true },
    {
      name: "structured conflict",
      output: '{"status":"yielded"}',
      details: { status: "deferred" },
    },
    { name: "explicit empty status", output: '{"status":"yielded"}', details: { status: null } },
  ])("does not confirm a $name", ({ output, details, isError }) => {
    const messages = withYieldResult([{ type: "text", text: output }], { details, isError });
    expect(pendingSessionsYield(messages)).toBeNull();
    expect(projectHistory(messages, { showToolCalls: false })).toEqual([]);
  });

  it("uses only the selected structured receipt's public acknowledgment", () => {
    const messages = withYieldResult(
      [{ type: "text", text: '{"status":"error","acknowledgment":"Not selected"}' }],
      {
        details: {
          status: "yielded",
          acknowledgment: "Waiting for the review.",
          message: "PRIVATE",
        },
      },
    );
    expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
    const items = projectHistory(messages);
    expect(groupTexts(items)).toEqual([expect.stringContaining("Waiting for the review.")]);
    expect(JSON.stringify(items)).not.toMatch(/PRIVATE|Not selected/);
  });

  describe("a run that resumed the handoff", () => {
    const asked = { role: "user", content: "Split the work.", timestamp: 1_000 };
    const request = { askedAt: 1_000, runIds: ["parent-run"] };
    const working = { runActive: true, runWorking: true, streamStartedAt: 3_000 };
    const status = (messages: unknown[], overrides: Parameters<typeof createProps>[0] = {}) =>
      projectHistory(messages, { runId: "resumed-run", ...working, ...overrides }).find(
        (item) => item.kind === "reading-indicator",
      );

    it("counts from the request and names the run that handed off", () => {
      expect(status([asked, ...separateHistory])).toMatchObject({
        runId: "resumed-run",
        startedAt: 1_000,
        request,
      });
      // Search hides rows, not what the run is answering.
      expect(
        status([asked, ...separateHistory], { searchOpen: true, searchQuery: "no such text" }),
      ).toMatchObject({ startedAt: 1_000, request });
      // A second handoff in the same request extends the chain, oldest run first.
      const again = handoffRun("second-run", 500);
      expect(status([asked, ...separateHistory, ...again])).toMatchObject({
        request: { askedAt: 1_000, runIds: ["parent-run", "second-run"] },
      });
    });

    it.each([1, 2])("counts each run once after %s handoffs", (handoffCount) => {
      const runIds = ["parent-run", "second-run"].slice(0, handoffCount);
      const runId = runIds.at(-1)!;
      const messages = [asked, ...runIds.flatMap((id, index) => handoffRun(id, index * 1_000))];
      const usageByRun = new Map(
        runIds.map((id, index) => [id, { outputTokens: index === 0 ? 4_100 : 256, seq: 1 }]),
      );
      const props = createProps({
        messages,
        subagentWait: { startedAt: 3_500, runId },
      });
      const { workingIndicator, runOutputTokens } = projectTranscriptActivity(
        buildChatItems(props),
        { ...props, runUsageById: usageByRun },
      );
      const expectedTokens = handoffCount === 1 ? 4_100 : 4_356;
      expect(runOutputTokens).toBe(expectedTokens);
      const host = { turnRecapWatch: null };
      const params = { sessionKey: props.sessionKey, usageByRun };
      resolveTurnRecap(host, { ...params, indicator: workingIndicator });
      expect(
        resolveTurnRecap(host, {
          ...params,
          row: { lastRunId: runId, status: "done", runtimeMs: 1_000, endedAt: 5_000 },
        }),
      ).toEqual({ runId, runtimeMs: 4_000, outputTokens: expectedTokens });
    });

    it("is recognized before the pane knows its run id", () => {
      resetWorkingProgress();
      const items = projectHistory([asked, ...separateHistory], working);
      const unnamed = items.find((item) => item.kind === "reading-indicator");
      expect(unnamed).toMatchObject({ startedAt: 1_000, request });
      expect(unnamed).not.toHaveProperty("runId");
    });

    it("keeps its own status when the turn is not just that chain", () => {
      // The request is outside the loaded window.
      const unanchored = status(separateHistory);
      expect(unanchored).toMatchObject({ runId: "resumed-run", startedAt: 3_000 });
      expect(unanchored).not.toHaveProperty("request");
      // A message sent after the handoff starts a request of its own.
      const later = { role: "user", content: "Also check the docs.", timestamp: 2_500 };
      expect(status([asked, ...separateHistory, later])).not.toHaveProperty("request");
      // Another run already answered before the one that handed off began.
      const earlier = { role: "assistant", runId: "first-run", timestamp: 1_500, content: "Done." };
      expect(status([asked, earlier, ...separateHistory])).not.toHaveProperty("request");
    });
  });
});

const resumedReply = { role: "assistant", content: "Back again.", timestamp: 4_000 };

function messageWait(acknowledgment?: string, waitFor?: "message") {
  return [
    { role: "user", content: "talk to parent session", timestamp: 1_000 },
    yieldRequest({ ...(waitFor ? { waitFor } : {}), message: "PRIVATE_CONTINUATION" }, [
      { type: "thinking", thinking: "Wait for the parent." },
    ]),
    {
      ...separateHistory[1],
      content: [{ type: "text", text: JSON.stringify({ status: "yielded", acknowledgment }) }],
    },
  ];
}
const groupTexts = (items: ReturnType<typeof buildChatItems>) =>
  items.flatMap((item) =>
    item.kind === "group"
      ? [[item.role, ...item.messages.map(({ message }) => JSON.stringify(message))].join(" ")]
      : [],
  );

it("keeps a runtime notice for a message wait that says nothing", () => {
  const messages = messageWait(undefined, "message");
  const items = projectHistory(messages);
  expect(items.filter((item) => item.kind === "group").map((item) => item.role)).toEqual(["user"]);
  expect(items).toContainEqual(waitingNotice);
  expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
  const resumed = projectHistory([...messages, resumedReply]);
  expect(resumed).not.toContainEqual(waitingNotice);
});

it.each([
  ["message", "message" as const],
  ["child", undefined],
])(
  "speaks a %s wait's acknowledgment as the run that handed off, before and after it resumes",
  (_name, waitFor) => {
    const acknowledgment = "Started the backend session.\n\nI’ll report back when it finishes.";
    const messages = messageWait(acknowledgment, waitFor);
    const items = projectHistory(messages);
    expect(items.filter((item) => item.kind === "notice" && item.text)).toEqual([]);
    const [user, assistant, ...rest] = groupTexts(items);
    expect([user?.startsWith("user"), rest]).toEqual([true, []]);
    expect(assistant).toContain(JSON.stringify(acknowledgment));
    expect(assistant).not.toContain("resumedAt");
    expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
    const resumed = projectHistory([...messages, { ...resumedReply, runId: "resumed-run" }]);
    // It stays, and marks how long the run waited before it resumed.
    expect(handoffDisplays(resumed)).toEqual([{ yieldedAt: 2_000, resumedAt: 4_000 }]);
    expect(JSON.stringify(resumed)).toContain(JSON.stringify(acknowledgment));
    expect(resumed.filter((item) => item.kind === "notice" && item.text)).toEqual([]);
    // A message sent meanwhile starts its own block rather than resuming this one.
    const interrupted = projectHistory([
      ...messages,
      { role: "user", content: "Any news?", timestamp: 3_000 },
    ]);
    expect(handoffDisplays(interrupted)).toEqual([{ yieldedAt: 2_000 }]);
  },
);

it("does not revive a completed message wait when search hides the resumed reply", () => {
  const messages = [
    {
      ...separateHistory[0],
      content: [
        { type: "text", text: "Waiting for the parent." },
        { ...call, arguments: { waitFor: "message" } },
        result,
      ],
    },
  ];
  const search = { searchOpen: true, searchQuery: "Waiting for the parent" };
  expect(projectHistory(messages, search)).toContainEqual(waitingNotice);
  expect(projectHistory([...messages, resumedReply], search)).not.toContainEqual(waitingNotice);
});

it("keeps Code Mode activity and speaks its yield acknowledgment without an empty assistant row", () => {
  const items = projectHistory(emptyAssistantHistory());
  const assistant = items.flatMap((item) =>
    item.kind === "group" && item.role === "assistant" ? item.messages : [],
  );
  expect(assistant.map(({ message }) => JSON.stringify(message))).toEqual([
    expect.stringContaining(JSON.stringify(emptyAssistantAcknowledgment)),
  ]);
  expect(items.filter((item) => item.kind === "notice" && item.text)).toEqual([]);
  expect(transcriptTools(items).map((card) => card.name)).toEqual([
    "exec",
    "exec",
    "sessions_list",
    "sessions_list",
  ]);
  expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
});
