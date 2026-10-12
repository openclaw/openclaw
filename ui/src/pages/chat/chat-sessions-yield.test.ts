// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { resetWorkingProgress } from "./chat-progress.ts";
import { pendingSessionsYield } from "./chat-sessions-yield.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { createProps } from "./chat-thread.test-support.ts";

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

  it.each([
    {
      role: "assistant",
      content: [{ type: "image", url: "https://example.invalid/proof.png" }],
      timestamp: 3_000,
    },
  ])("separates later $role activity from the run that handed off", (later) => {
    const messages = [...separateHistory, later];
    const items = buildChatItems(createProps({ messages }));
    // The boundary is structural: it carries nothing a reader could see.
    expect(items.filter((item) => item.kind === "notice")).toEqual([silentBoundary]);
    expect(items[0]).toMatchObject({ kind: "notice", handoffBoundary: true });
    expect(items[0]).not.toHaveProperty("label");
    expect(pendingSessionsYield(messages)).toBeNull();
  });

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

  it("gives the pending wait the handed-off run's identity and yields to an own run", () => {
    const messages = [
      {
        role: "assistant",
        runId: "parent-run",
        timestamp: 1_900,
        content: [{ type: "text", text: "Delegating the backend." }],
      },
      ...separateHistory,
    ];
    const items = buildChatItems(
      createProps({ messages, subagentWait: { startedAt: 2_500, runId: "parent-run" } }),
    );
    expect(items.filter((item) => item.kind === "notice")).toEqual([silentBoundary]);
    expect(items.at(-1)).toMatchObject({
      kind: "reading-indicator",
      waitingOn: "subagents",
      startedAt: 2_500,
      runId: "parent-run",
    });
    // An own run owns the indicator; the wait never competes with it.
    const working = buildChatItems(
      createProps({
        messages,
        runId: "resumed-run",
        runActive: true,
        runWorking: true,
        streamStartedAt: 3_000,
        subagentWait: { startedAt: 2_500, runId: "parent-run" },
      }),
    );
    expect(working.filter((item) => item.kind === "reading-indicator")).toEqual([
      expect.objectContaining({ runId: "resumed-run" }),
    ]);
    expect(working.at(-1)).not.toHaveProperty("waitingOn");
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
