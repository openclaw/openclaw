// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { pendingSessionsYield, projectSessionsYieldItems } from "./chat-sessions-yield.ts";
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

describe("sessions_yield transcript projection", () => {
  it.each([false, true])(
    "preserves non-yield item identity with showToolCalls=%s",
    (showToolCalls) => {
      const items = [
        {
          role: "assistant",
          content: [{ type: "text", text: "Implementation continues." }],
          activity: [],
        },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "read",
          toolName: "read",
          content: [{ type: "text", text: "Project documentation" }],
        },
      ].map(
        (message, index) =>
          ({ kind: "message", key: `ordinary:${index}`, message }) satisfies ChatItem,
      );
      const projected = projectSessionsYieldItems(items, showToolCalls);
      for (const [index, item] of items.entries()) {
        expect(projected[index]).toBe(item);
      }
      expect(projected).toHaveLength(items.length);
    },
  );

  it.each([
    ["separate call and result", separateHistory],
    ["nested exec activity", nestedHistory],
  ])("leaves no transcript row for %s and reports the pending handoff", (_name, messages) => {
    const original = structuredClone(messages);
    expect(buildChatItems(createProps({ messages, showToolCalls: false }))).toEqual([]);
    expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
    expect(pendingSessionsYield(messages)).toEqual(pendingHandoff);
    expect(messages).toEqual(original);
  });

  it.each([
    { role: "assistant", content: "Continuing the implementation.", timestamp: 3_000 },
    {
      role: "assistant",
      content: [{ type: "image", url: "https://example.invalid/proof.png" }],
      timestamp: 3_000,
    },
    { role: "user", content: "Continue.", timestamp: 3_000 },
  ])("separates later $role activity from the run that handed off", (later) => {
    const messages = [...separateHistory, later];
    const items = buildChatItems(createProps({ messages }));
    // The boundary is structural: it carries nothing a reader could see.
    expect(items.filter((item) => item.kind === "notice")).toEqual([
      expect.objectContaining({ handoffBoundary: true, text: "" }),
    ]);
    expect(items[0]).toMatchObject({ kind: "notice", handoffBoundary: true });
    expect(items[0]).not.toHaveProperty("label");
    expect(pendingSessionsYield(messages)).toBeNull();
  });

  it.each([false, true])(
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
    expect(items.some((item) => item.kind === "notice")).toBe(false);
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

  it.each([
    [separateHistory[0]!],
    [separateHistory[1]!],
    [
      separateHistory[0]!,
      { ...separateHistory[1], content: [{ type: "text", text: '{"status":"error"}' }] },
    ],
  ])("requires a successful call/result pair", (...messages) => {
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
    expect(items.some((item) => item.kind === "notice")).toBe(false);
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
});
