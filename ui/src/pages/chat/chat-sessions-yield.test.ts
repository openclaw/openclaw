// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { latestSessionsYieldTimestamp } from "./chat-sessions-yield.ts";
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

describe("sessions_yield transcript markers", () => {
  it.each([
    ["separate call and result", separateHistory],
    ["nested exec activity", nestedHistory],
  ])("keeps %s visible with tool calls hidden", (_name, messages) => {
    const original = structuredClone(messages);
    const items = buildChatItems(createProps({ messages, showToolCalls: false }));
    expect(items).toEqual([
      expect.objectContaining({
        kind: "notice",
        label: "Handed off and waiting",
        text: "",
        timestamp: 2_000,
      }),
    ]);
    expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
    expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
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
  ])("marks the yield resumed after later $role activity", (later) => {
    const messages = [...separateHistory, later];
    const markers = buildChatItems(createProps({ messages })).filter(
      (item) => item.kind === "notice",
    );
    expect(markers).toEqual([expect.objectContaining({ label: "Resumed", timestamp: 2_000 })]);
    expect(latestSessionsYieldTimestamp(messages)).toBeNull();
  });

  it("marks the yield resumed when a new own run starts before its first output", () => {
    const items = buildChatItems(
      createProps({
        messages: separateHistory,
        runId: "resumed-run",
        runActive: true,
        runWorking: true,
        streamStartedAt: 3_000,
      }),
    );
    expect(items.find((item) => item.kind === "notice")).toMatchObject({ label: "Resumed" });
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
      expect(items.some((item) => item.kind === "notice")).toBe(false);
      if (failed) {
        expect(JSON.stringify(items)).toContain("Yield rejected");
      }
      expect(messages).toEqual(original);
    },
  );

  it("keeps a nested yield waiting when its exec wrapper completes in the same run", () => {
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
    const items = buildChatItems(createProps({ messages }));
    expect(items.find((item) => item.kind === "notice")).toMatchObject({
      label: "Handed off and waiting",
    });
    expect(latestSessionsYieldTimestamp(messages)).toBe(2_000);
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
    expect(items.at(-1)).toMatchObject({ kind: "notice", label: "Handed off and waiting" });
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
    expect(buildChatItems(createProps({ messages })).some((item) => item.kind === "notice")).toBe(
      false,
    );
    expect(latestSessionsYieldTimestamp(messages)).toBeNull();
    expect(buildChatItems(createProps({ messages, showToolCalls: false }))).toEqual([]);
  });
});
