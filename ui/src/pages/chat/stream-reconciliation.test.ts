// @vitest-environment node
// Control UI tests cover stream reconciliation behavior.
import { describe, expect, it } from "vitest";
import {
  appendTerminalAssistantMessage,
  historyReplacedVisibleStream,
  materializeVisibleStreamState,
  visibleAssistantStreamParts,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";
import {
  pruneHistoryReplacedStreamSegments,
  prunePersistedAssistantStreamSegments,
  prunePersistedToolStreamMessages,
} from "./stream-segment-pruning.ts";
import { rememberLiveTerminalRun } from "./terminal-message-identity.ts";
import type { ToolStreamEntry } from "./tool-stream-contract.ts";
import { buildToolStreamIdentity, persistedCurrentToolStreamIds } from "./tool-stream-identity.ts";

type StreamReconciliationState = Parameters<typeof materializeVisibleStreamState>[1];

const visibleStreamOptions = {
  isHiddenAssistantMessage: () => false,
  isHiddenStreamText: () => false,
  persistCommentary: true,
};

function makeIdleStreamState<T extends Record<string, unknown>>(overrides: T) {
  return {
    chatStream: null,
    chatStreamStartedAt: null,
    chatStreamSegments: [],
    chatToolMessages: [],
    toolStreamById: new Map<string, ToolStreamEntry>(),
    toolStreamOrder: [],
    ...overrides,
  } satisfies StreamReconciliationState;
}

function messageText(message: unknown): string | null {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : null;
  }
  const first = content[0] as { text?: unknown } | undefined;
  return typeof first?.text === "string" ? first.text : null;
}

function createToolStreamEntry(
  toolCallId: string,
  runId = "run-active",
  message: Record<string, unknown> = { toolCallId, runId },
): ToolStreamEntry {
  return { toolCallId, runId, message, name: "tool", startedAt: 0, receivedAt: 0 };
}

function createConcurrentToolStreamState() {
  const toolCallId = "call-shared";
  const foregroundIdentity = buildToolStreamIdentity("run-foreground", toolCallId);
  const backgroundIdentity = buildToolStreamIdentity("run-background", toolCallId);
  const foregroundMessage = {
    role: "assistant",
    runId: "run-foreground",
    toolCallId,
    content: [{ type: "toolcall", name: "read", arguments: { path: "foreground.txt" } }],
  };
  const backgroundMessage = {
    role: "assistant",
    runId: "run-background",
    toolCallId,
    content: [{ type: "toolcall", name: "exec", arguments: { command: "background" } }],
  };
  const state = {
    chatStream: "foreground still running",
    chatStreamStartedAt: 5,
    chatStreamSegments: [
      { text: "before foreground", ts: 2, runId: "run-foreground", toolCallId },
      { text: "before background", ts: 3, runId: "run-background", toolCallId },
    ],
    chatToolMessages: [foregroundMessage, backgroundMessage],
    toolStreamById: new Map([
      [foregroundIdentity, createToolStreamEntry(toolCallId, "run-foreground", foregroundMessage)],
      [backgroundIdentity, createToolStreamEntry(toolCallId, "run-background", backgroundMessage)],
    ]),
    toolStreamOrder: [foregroundIdentity, backgroundIdentity],
  };
  return { state, toolCallId, foregroundIdentity, backgroundIdentity, foregroundMessage };
}

describe("stream reconciliation", () => {
  it("settles a paged steered run before unrelated input", () => {
    const messages = [
      { role: "user", content: "Original", __openclaw: { idempotencyKey: "run:user" } },
      {
        role: "user",
        content: "Steer",
        __openclaw: { idempotencyKey: "steer:user", steerTargetRunId: "run" },
      },
      { role: "user", content: "Next", __openclaw: { idempotencyKey: "next:user" } },
    ];
    const state = makeIdleStreamState({
      chatRunId: "run",
      chatStream: "Partial",
      chatStreamStartedAt: 1,
    });
    const materialized = materializeVisibleStreamState(messages, state, visibleStreamOptions);
    expect(materialized.map(messageText)).toEqual(["Original", "Steer", "Partial", "Next"]);
    const terminal = rememberLiveTerminalRun({ role: "assistant", content: "Complete" }, "run");
    expect(appendTerminalAssistantMessage(materialized, terminal).map(messageText)).toEqual([
      "Original",
      "Steer",
      "Complete",
      "Next",
    ]);
  });

  it("retains commentary boundaries with a paged input", () => {
    const messages = [
      {
        role: "user",
        content: "Steer",
        timestamp: 50,
        __openclaw: { idempotencyKey: "steer:user", steerTargetRunId: "run" },
      },
    ];
    const state = makeIdleStreamState({
      chatRunId: "run",
      chatStreamSegments: [
        { runId: "run", itemId: "before", text: "Before", ts: 100, afterUserSendId: "run" },
        { runId: "run", itemId: "after", text: "After", ts: 0, afterUserSendId: "steer" },
      ],
    });
    expect(
      materializeVisibleStreamState(messages, state, visibleStreamOptions).map(messageText),
    ).toEqual(["Before", "Steer", "After"]);
  });

  it("preserves reused commentary from another run before the user boundary loads", () => {
    const persisted = {
      role: "assistant",
      content: [{ type: "text", text: "Saved commentary" }],
      timestamp: 1,
      __openclaw: { id: "saved", seq: 1, runId: "run-other" },
      openclawStreamFallback: { itemId: "shared-item", source: "segment" },
    };
    const segment = {
      text: "Current commentary",
      ts: 2,
      itemId: "shared-item",
      runId: "run-active",
    };
    const state = makeIdleStreamState({
      chatRunId: "run-active",
      chatStreamSegments: [segment],
    });
    expect(
      materializeVisibleStreamState([persisted], state, visibleStreamOptions).map(messageText),
    ).toEqual(["Saved commentary", "Current commentary"]);
    prunePersistedAssistantStreamSegments(state, persisted);
    expect(state.chatStreamSegments).toEqual([segment]);
  });

  it("does not replay a keyed preamble across a same-run steer boundary", () => {
    const state = makeIdleStreamState({
      chatRunId: "active-run",
      chatStreamSegments: [
        {
          text: "already visible",
          ts: 2,
          itemId: "preamble-1",
          runId: "active-run",
        },
        { text: "distinct item", ts: 4, itemId: "preamble-2", runId: "active-run" },
        { text: "already visible", ts: 5, runId: "active-run" },
      ],
    });
    const messages = [
      {
        role: "user",
        content: "original ask",
        timestamp: 1,
        __openclaw: { idempotencyKey: "active-run:user" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "already visible" }],
        timestamp: 2,
        openclawStreamFallback: {
          itemId: "preamble-1",
          runId: "active-run",
          replacementText: "already visible",
          source: "segment",
        },
      },
      {
        role: "user",
        content: "steer this run",
        timestamp: 3,
        __openclaw: { idempotencyKey: "steer-run:user", steerTargetRunId: "active-run" },
      },
    ];

    const next = materializeVisibleStreamState(messages, state, visibleStreamOptions);

    expect(next.map(messageText)).toEqual([
      "original ask",
      "already visible",
      "steer this run",
      "distinct item",
      "already visible",
    ]);
  });

  it("does not prune keyed preambles by live tool index", () => {
    const identity = buildToolStreamIdentity("run-active", "call_1");
    const state = makeIdleStreamState({
      chatStreamSegments: [
        { text: "keyed preamble", ts: 2, itemId: "preamble-1" },
        { text: "before tool", ts: 3, toolCallId: "call_1" },
      ],
      chatToolMessages: [{ role: "toolResult", toolCallId: "call_1", content: "tool output" }],
      toolStreamById: new Map([[identity, createToolStreamEntry("call_1")]]),
      toolStreamOrder: [identity],
    });

    prunePersistedToolStreamMessages(state, new Set([identity]));

    expect(visibleAssistantStreamParts(state, visibleStreamOptions)).toMatchObject([
      { text: "keyed preamble", itemId: "preamble-1" },
    ]);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("retains the cumulative baseline after history replaces an earlier displayed prefix", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [
        {
          text: "Before steer.",
          ts: 1,
          runId: "active-run",
        },
        {
          text: "Before steer. After steer.",
          ts: 2,
          runId: "active-run",
        },
      ],
    });

    pruneHistoryReplacedStreamSegments(
      [{ role: "assistant", content: "Before steer.", timestamp: 1 }],
      state,
      visibleStreamOptions,
    );

    expect(visibleAssistantStreamParts(state, visibleStreamOptions)).toMatchObject([
      { text: "After steer." },
    ]);
    expect(
      visibleCurrentAssistantStreamTail(
        { ...state, chatStream: "Before steer. After steer. Continued." },
        () => false,
      ),
    ).toBe("Continued.");
  });

  it("prunes only the persisted run when sibling tools share a call id", () => {
    const { state, toolCallId, foregroundIdentity, backgroundIdentity, foregroundMessage } =
      createConcurrentToolStreamState();
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      {
        role: "toolResult",
        runId: "run-background",
        toolCallId,
        content: "background complete",
      },
    ];

    const persisted = persistedCurrentToolStreamIds(messages, state);

    expect(persisted).toEqual(new Set([backgroundIdentity]));
    prunePersistedToolStreamMessages(state, persisted);

    expect(state.toolStreamOrder).toEqual([foregroundIdentity]);
    expect(state.toolStreamById.has(foregroundIdentity)).toBe(true);
    expect(state.toolStreamById.has(backgroundIdentity)).toBe(false);
    expect(state.chatToolMessages).toEqual([foregroundMessage]);
    expect(
      visibleAssistantStreamParts(state, { ...visibleStreamOptions, includeCurrent: false }),
    ).toMatchObject([{ text: "before foreground", runId: "run-foreground", toolCallId }]);
  });

  it("does not attribute an unscoped persisted result to either colliding run", () => {
    const { state, toolCallId, foregroundIdentity, backgroundIdentity } =
      createConcurrentToolStreamState();
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      { role: "toolResult", toolCallId, content: "unscoped output" },
    ];

    const persisted = persistedCurrentToolStreamIds(messages, state);

    expect(persisted).toEqual(new Set());
    prunePersistedToolStreamMessages(state, persisted);
    expect(state.toolStreamOrder).toEqual([foregroundIdentity, backgroundIdentity]);
    expect(state.toolStreamById.size).toBe(2);
    expect(state.chatToolMessages).toHaveLength(2);
    expect(state.chatStreamSegments).toHaveLength(2);
  });

  it("reconciles a whitespace call ID through its serialized live identity", () => {
    const toolCallId = " ";
    const runId = "run-live";
    const identity = buildToolStreamIdentity(runId, toolCallId);
    const state = makeIdleStreamState({
      toolStreamById: new Map([[identity, createToolStreamEntry(toolCallId, runId)]]),
      toolStreamOrder: [identity],
    });
    expect(
      persistedCurrentToolStreamIds(
        [{ role: "toolResult", runId, toolCallId: '["run-live"," "]' }],
        state,
      ),
    ).toEqual(new Set([identity]));
  });

  it("prunes persisted tool messages across current tool id shapes", () => {
    const toolStreamById = new Map(
      ["call_1", "call_2", "call_3", "call_4"].map((id) => [
        buildToolStreamIdentity("run-active", id),
        createToolStreamEntry(id),
      ]),
    );
    const identities = [...toolStreamById.keys()];
    const messages = [
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "shell",
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        tool_name: "shell",
      },
      {
        role: "assistant",
        content: [{ type: "toolcall", id: "call_3", name: "shell", arguments: {} }],
      },
      {
        role: "assistant",
        content: [{ type: "tool_result", tool_use_id: "call_4", name: "shell", content: "ok" }],
      },
      { role: "assistant", content: "hello" },
      { role: "user", content: "hello" },
    ];
    const state = makeIdleStreamState({
      chatToolMessages: messages,
      toolStreamById,
      toolStreamOrder: identities,
      chatStreamSegments: [],
    });

    prunePersistedToolStreamMessages(state, new Set(identities));

    expect(state.chatToolMessages).toEqual([
      { role: "assistant", content: "hello" },
      { role: "user", content: "hello" },
    ]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("keeps an interrupted run fallback outside a later terminal run", () => {
    const userA = {
      role: "user",
      content: "Run A",
      timestamp: 1,
      __openclaw: { idempotencyKey: "run-a:user" },
    };
    const fallbackA = materializeVisibleStreamState(
      [userA],
      makeIdleStreamState({
        chatRunId: "run-a",
        chatStream: "Interrupted A",
        chatStreamStartedAt: 2,
        chatStreamSegments: [],
      }),
      visibleStreamOptions,
    )[1];
    const userB = {
      role: "user",
      content: "Run B",
      timestamp: 3,
      __openclaw: { idempotencyKey: "run-b:user" },
    };
    const terminalB = rememberLiveTerminalRun(
      {
        role: "assistant",
        content: [{ type: "text", text: "Finished B" }],
        timestamp: 4,
      },
      "run-b",
    );

    const next = appendTerminalAssistantMessage([userA, fallbackA, userB], terminalB);

    expect(next.map(messageText)).toEqual(["Run A", "Interrupted A", "Run B", "Finished B"]);
  });

  it("reconciles a stream segment only inside its persisted ordinary-user interval", () => {
    const state = makeIdleStreamState({
      chatStream: "Before steer. After steer.",
      chatStreamStartedAt: 4,
      chatStreamSegments: [
        {
          text: "Before steer.",
          ts: 3,
          runId: "active-run",
        },
      ],
    });
    const messages = [
      {
        role: "user",
        content: "Original prompt",
        timestamp: 2,
        __openclaw: { idempotencyKey: "active-run:user" },
      },
      {
        role: "assistant",
        content: "Before steer.",
        timestamp: 100,
        __openclaw: { idempotencyKey: "active-run" },
      },
      {
        role: "user",
        content: "Steer prompt",
        timestamp: 1,
        __openclaw: { idempotencyKey: "steer-run:user" },
      },
    ];

    expect(historyReplacedVisibleStream(messages, state, visibleStreamOptions)).toBe(false);
    expect(
      materializeVisibleStreamState(messages, state, {
        ...visibleStreamOptions,
        includeCurrent: false,
      }).map(messageText),
    ).toEqual(["Original prompt", "Before steer.", "Steer prompt"]);
  });

  it("does not treat matching terminal text as a keyed preamble replacement", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    });
    const terminalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "before tool\nfinal answer" }],
      timestamp: 3,
    };
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }, terminalMessage];

    expect(historyReplacedVisibleStream(messages, state, visibleStreamOptions)).toBe(false);
    const materialized = materializeVisibleStreamState(messages.slice(0, 1), state, {
      ...visibleStreamOptions,
      replacementMessages: [terminalMessage],
      includeCurrent: false,
    });
    expect(materialized.map(messageText)).toEqual(["latest ask", "before tool"]);
    expect(appendTerminalAssistantMessage(materialized, terminalMessage).map(messageText)).toEqual([
      "latest ask",
      "before tool",
      "before tool\nfinal answer",
    ]);
  });

  it("does not require transient keyed commentary to be present in history", () => {
    const state = makeIdleStreamState({
      chatStreamSegments: [{ text: "before tool", ts: 2, itemId: "preamble-1" }],
    });
    const messages = [
      { role: "user", content: "latest ask", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "final answer" }], timestamp: 3 },
    ];

    expect(
      historyReplacedVisibleStream(messages, state, {
        ...visibleStreamOptions,
        persistCommentary: false,
      }),
    ).toBe(true);
  });

  it("still materializes the current stream tail when persistCommentary is false", () => {
    const state = makeIdleStreamState({
      chatStream: "draft answer",
      chatStreamStartedAt: 3,
      chatStreamSegments: [{ text: "transient preamble", ts: 2, itemId: "preamble-1" }],
    });
    const messages = [{ role: "user", content: "latest ask", timestamp: 1 }];

    const next = materializeVisibleStreamState(messages, state, {
      ...visibleStreamOptions,
      persistCommentary: false,
    });

    expect(next.map(messageText)).toEqual(["latest ask", "draft answer"]);
  });

  it("sequentially consumes incremental tool fallbacks before one terminal", () => {
    const state = makeIdleStreamState({
      chatRunId: "active-run",
      chatStream: null,
      chatStreamStartedAt: null,
      chatStreamSegments: [
        { text: "A", ts: 2, runId: "active-run", toolCallId: "call-a" },
        { text: "A B", ts: 3, runId: "active-run", toolCallId: "call-b" },
      ],
    });
    const messages = [
      {
        role: "user",
        content: "latest ask",
        timestamp: 1,
        __openclaw: { idempotencyKey: "active-run:user" },
      },
    ];
    const materialized = materializeVisibleStreamState(messages, state, visibleStreamOptions);
    const terminal = rememberLiveTerminalRun(
      {
        role: "assistant",
        content: [{ type: "text", text: "A B Final" }],
        timestamp: 4,
      },
      "active-run",
    );

    const next = appendTerminalAssistantMessage(materialized, terminal);

    expect(next.map(messageText)).toEqual(["latest ask", "A B Final"]);
  });
});
