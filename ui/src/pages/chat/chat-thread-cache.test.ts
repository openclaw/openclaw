// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractToolCardsCached as extractToolCards } from "../../lib/chat/tool-cards.ts";
import {
  messageRecoveryKey,
  type AssistantMessageExpansionState,
} from "./chat-message-recovery.ts";
import {
  buildCachedChatItems,
  getExpansionStateVersion,
  resetChatThreadState,
  setExpansionState,
} from "./chat-thread.ts";

function createProps(
  overrides: Partial<Parameters<typeof buildCachedChatItems>[0]> = {},
): Parameters<typeof buildCachedChatItems>[0] {
  return {
    paneId: "startup-cache",
    sessionKey: "main",
    runId: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

describe("thread item cache startup revalidation", () => {
  it("retains completed tool rows across empty startup state publications", () => {
    resetChatThreadState();
    const result = {
      role: "toolResult",
      toolCallId: "completed",
      toolName: "exec",
      content: [{ type: "tool_result", id: "completed", name: "exec", text: "done" }],
      timestamp: 2,
    };
    const input = createProps({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "completed", name: "exec", input: { command: "echo done" } },
          ],
          timestamp: 1,
        },
        result,
      ],
      loading: true,
      runWorking: false,
    });
    const first = buildCachedChatItems(input);
    expect(
      first
        .filter((item) => item.kind === "group")
        .flatMap((group) => group.messages.flatMap((entry) => extractToolCards(entry.message))),
    ).toMatchObject([{ outputText: "done", completed: true }]);
    expect(buildCachedChatItems({ ...input, pendingInputs: [] })).toBe(first);
    expect(buildCachedChatItems({ ...input, pendingInputs: [], loading: false })).toBe(first);
    result.content = [{ type: "tool_result", id: "completed", name: "exec", text: "updated" }];
    const updated = buildCachedChatItems({
      ...input,
      messages: [...input.messages],
      loading: false,
    });
    expect(
      updated
        .filter((item) => item.kind === "group")
        .flatMap((group) => group.messages.flatMap((entry) => extractToolCards(entry.message))),
    ).toMatchObject([{ outputText: "updated", completed: true }]);
  });

  it("shows and removes newly published pending input", () => {
    resetChatThreadState();
    const input = createProps();
    expect(buildCachedChatItems(input)).toEqual([]);
    const pendingInput = {
      acceptedAt: 1,
      id: "pending-follow-up",
      message: { role: "user", content: "continue", timestamp: 1 },
      runId: "follow-up-run",
      state: "queued" as const,
    };
    const pending = buildCachedChatItems({ ...input, pendingInputs: [pendingInput] });
    expect(
      pending
        .filter((item) => item.kind === "group")
        .flatMap((group) => group.messages.map((entry) => entry.message)),
    ).toContainEqual(pendingInput.message);
    expect(buildCachedChatItems({ ...input, pendingInputs: [] })).toEqual([]);
  });

  it("refreshes recovered search results after empty startup publications", () => {
    resetChatThreadState();
    const preview = {
      role: "assistant",
      content: "Preview",
      timestamp: 1,
      __openclaw: { id: "recovered-reply", truncated: true },
    };
    const messages = new Map<string, AssistantMessageExpansionState>();
    const input = createProps({
      messages: [preview],
      loading: true,
      runWorking: false,
      searchOpen: true,
      searchQuery: "needle",
      messageRecovery: { messages, revision: getExpansionStateVersion(messages), agentId: "work" },
    });
    expect(buildCachedChatItems(input)).toEqual([]);
    const settled = { ...input, pendingInputs: [], loading: false };
    expect(buildCachedChatItems(settled)).toEqual([]);

    const recovered: AssistantMessageExpansionState = {
      status: "loaded",
      markdown: "Recovered needle",
      revision: 1,
    };
    setExpansionState(messages, messageRecoveryKey("work", "recovered-reply"), recovered);
    const recovery = { messages, revision: getExpansionStateVersion(messages), agentId: "work" };
    expect(buildCachedChatItems({ ...settled, messageRecovery: recovery })).toMatchObject([
      { kind: "group", messages: [{ message: preview }] },
    ]);

    const replaced = {
      ...recovery,
      messages: new Map([
        [messageRecoveryKey("work", "recovered-reply"), { ...recovered, markdown: "Other reply" }],
        [messageRecoveryKey("other", "recovered-reply"), recovered],
      ]),
    };
    expect(buildCachedChatItems({ ...settled, messageRecovery: replaced })).toEqual([]);
    expect(
      buildCachedChatItems({
        ...settled,
        messageRecovery: { ...replaced, agentId: "other" },
      }),
    ).toMatchObject([{ kind: "group", messages: [{ message: preview }] }]);
  });

  it("yields to the initial-load skeleton on an empty thread", () => {
    const input = createProps({ runWorking: true, loading: true });
    expect(buildCachedChatItems(input).some((item) => item.kind === "reading-indicator")).toBe(
      false,
    );
    expect(
      buildCachedChatItems({ ...input, loading: false }).some(
        (item) => item.kind === "reading-indicator",
      ),
    ).toBe(true);
  });
});
