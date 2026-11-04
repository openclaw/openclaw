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
const pendingHandoff = { timestamp: 2_000, runId: "parent-run" };
// A confirmed handoff leaves one structural item behind and nothing to draw.
const silentBoundary = expect.objectContaining({ kind: "notice", handoffBoundary: true, text: "" });

describe("sessions_yield transcript projection", () => {
  it.each([["nested exec activity", nestedHistory]])(
    "leaves no transcript row for %s and reports the pending handoff",
    (_name, messages) => {
      const original = structuredClone(messages);
      // Only the boundary remains, and it carries nothing a reader could see.
      expect(buildChatItems(createProps({ messages, showToolCalls: false }))).toEqual([
        silentBoundary,
      ]);
      expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
      expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
      expect(messages).toEqual(original);
    },
  );

  it.each([true])(
    "never displays private yield inputs before confirmation (failed=%s)",
    (failed) => {
      const messages = [
        {
          ...separateHistory[0],
          content: [{ ...call, arguments: { message: "PRIVATE_PENDING_CONTEXT" } }],
        },
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
      const items = buildChatItems(createProps({ messages, showToolCalls: true }));
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
    const items = buildChatItems(createProps({ messages }));
    expect(items.filter((item) => item.kind === "notice")).toEqual([silentBoundary]);
    const remaining = items.flatMap((item) => (item.kind === "group" ? item.messages : []));
    expect(
      remaining.flatMap(({ message }) => extractToolCardsCached(message).map((card) => card.name)),
    ).toEqual(["read"]);
    expect(JSON.stringify(items)).toContain("Delegated implementation.");
    expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
    const hidden = buildChatItems(createProps({ messages, showToolCalls: false }));
    expect(
      hidden.flatMap((item) =>
        item.kind === "group"
          ? item.messages.flatMap(({ message }) => extractToolCardsCached(message))
          : [],
      ),
    ).toEqual([]);
    expect(JSON.stringify(hidden)).toContain("Delegated implementation.");
  });

  it.each([[separateHistory[1]!]])("requires a successful call/result pair", (...messages) => {
    expect(pendingSessionsYield(messages)).toBeNull();
    expect(buildChatItems(createProps({ messages, showToolCalls: false }))).toEqual([]);
  });

  describe("a run that resumed the handoff", () => {
    const asked = { role: "user", content: "Split the work.", timestamp: 1_000 };
    const request = { askedAt: 1_000, runIds: ["parent-run"] };
    const working = { runActive: true, runWorking: true, streamStartedAt: 3_000 };
    const status = (messages: unknown[], overrides: Parameters<typeof createProps>[0] = {}) =>
      buildChatItems(
        createProps({ messages, runId: "resumed-run", ...working, ...overrides }),
      ).find((item) => item.kind === "reading-indicator");

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
      const again = separateHistory.map((message) => ({
        ...message,
        runId: "second-run",
        timestamp: message.timestamp + 500,
      }));
      expect(status([asked, ...separateHistory, ...again])).toMatchObject({
        request: { askedAt: 1_000, runIds: ["parent-run", "second-run"] },
      });
    });

    it.each([2])("counts each run once after %s handoffs", (handoffCount) => {
      const runIds = ["parent-run", "second-run"].slice(0, handoffCount);
      const runId = runIds.at(-1)!;
      const messages = [
        asked,
        ...runIds.flatMap((id, index) =>
          separateHistory.map((message) => ({
            ...message,
            runId: id,
            timestamp: message.timestamp + index * 1_000,
          })),
        ),
      ];
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
      const items = buildChatItems(
        createProps({ messages: [asked, ...separateHistory], ...working }),
      );
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

function messageWait(acknowledgment?: string, waitFor?: "message") {
  return [
    { role: "user", content: "talk to parent session", timestamp: 1_000 },
    {
      ...separateHistory[0],
      content: [
        { type: "thinking", thinking: "Wait for the parent." },
        {
          ...call,
          arguments: { ...(waitFor ? { waitFor } : {}), message: "PRIVATE_CONTINUATION" },
        },
      ],
    },
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
  const notice = expect.objectContaining({ kind: "notice", text: "Waiting for a message" });
  const items = buildChatItems(createProps({ messages }));
  expect(items.filter((item) => item.kind === "group").map((item) => item.role)).toEqual(["user"]);
  expect(items).toContainEqual(notice);
  expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
  const resumed = buildChatItems(
    createProps({
      messages: [...messages, { role: "assistant", content: "Back again.", timestamp: 4_000 }],
    }),
  );
  expect(resumed).not.toContainEqual(notice);
});

it.each([
  ["message", "message" as const],
  ["child", undefined],
])(
  "speaks a %s wait's acknowledgment as the run that handed off, before and after it resumes",
  (_name, waitFor) => {
    const acknowledgment = "Started the backend session.\n\nI’ll report back when it finishes.";
    const messages = messageWait(acknowledgment, waitFor);
    const items = buildChatItems(createProps({ messages }));
    expect(items.filter((item) => item.kind === "notice" && item.text)).toEqual([]);
    const [user, assistant, ...rest] = groupTexts(items);
    expect([user?.startsWith("user"), rest]).toEqual([true, []]);
    expect(assistant).toContain(JSON.stringify(acknowledgment));
    expect(assistant).not.toContain("resumedAt");
    expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
    const resumed = buildChatItems(
      createProps({
        messages: [
          ...messages,
          { role: "assistant", runId: "resumed-run", content: "Back again.", timestamp: 4_000 },
        ],
      }),
    );
    const spoken = resumed
      .flatMap((item) => (item.kind === "group" ? item.messages : []))
      .map(({ message }) => readHandoffDisplay(message))
      .filter(Boolean);
    // It stays, and marks how long the run waited before it resumed.
    expect(spoken).toEqual([{ yieldedAt: 2_000, resumedAt: 4_000 }]);
    expect(JSON.stringify(resumed)).toContain(JSON.stringify(acknowledgment));
    expect(resumed.filter((item) => item.kind === "notice" && item.text)).toEqual([]);
    // A message sent meanwhile starts its own block rather than resuming this one.
    const interrupted = buildChatItems(
      createProps({
        messages: [...messages, { role: "user", content: "Any news?", timestamp: 3_000 }],
      }),
    );
    expect(
      interrupted
        .flatMap((item) => (item.kind === "group" ? item.messages : []))
        .map(({ message }) => readHandoffDisplay(message))
        .filter(Boolean),
    ).toEqual([{ yieldedAt: 2_000 }]);
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
  const notice = expect.objectContaining({ kind: "notice", text: "Waiting for a message" });
  expect(buildChatItems(createProps({ messages, ...search }))).toContainEqual(notice);
  expect(
    buildChatItems(
      createProps({
        messages: [...messages, { role: "assistant", content: "Back again.", timestamp: 4_000 }],
        ...search,
      }),
    ),
  ).not.toContainEqual(notice);
});

it("keeps Code Mode activity and speaks its yield acknowledgment without an empty assistant row", () => {
  const items = buildChatItems(createProps({ messages: emptyAssistantHistory() }));
  const assistant = items.flatMap((item) =>
    item.kind === "group" && item.role === "assistant" ? item.messages : [],
  );
  expect(assistant.map(({ message }) => JSON.stringify(message))).toEqual([
    expect.stringContaining(JSON.stringify(emptyAssistantAcknowledgment)),
  ]);
  expect(items.filter((item) => item.kind === "notice" && item.text)).toEqual([]);
  expect(
    items.flatMap((item) =>
      item.kind === "group"
        ? item.messages.flatMap(({ message }) =>
            extractToolCardsCached(message).map((card) => card.name),
          )
        : [],
    ),
  ).toEqual(["exec", "exec", "sessions_list", "sessions_list"]);
  expect(JSON.stringify(items)).not.toContain("PRIVATE_CONTINUATION");
});
