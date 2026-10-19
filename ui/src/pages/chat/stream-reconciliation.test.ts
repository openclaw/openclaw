// @vitest-environment node
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

function user(content: string, timestamp?: number, key?: string, target?: string) {
  return {
    role: "user",
    content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(key === undefined
      ? {}
      : {
          __openclaw: { idempotencyKey: key, ...(target ? { steerTargetRunId: target } : {}) },
        }),
  };
}
function assistant(text: string, timestamp?: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}
function streamSegment(
  text: string,
  ts: number,
  extra: Partial<StreamReconciliationState["chatStreamSegments"][number]> = {},
) {
  return { text, ts, ...extra };
}
function materialize(
  messages: unknown[],
  state: StreamReconciliationState,
  options: Partial<typeof visibleStreamOptions> & {
    includeCurrent?: boolean;
    replacementMessages?: unknown[];
  } = {},
) {
  return materializeVisibleStreamState(messages, state, { ...visibleStreamOptions, ...options });
}

function idle<T extends Record<string, unknown>>(overrides: T) {
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

function expectTexts(messages: unknown[], ...expected: string[]) {
  expect(messages.map(messageText)).toEqual(expected);
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
      user("Original", undefined, "run:user"),
      user("Steer", undefined, "steer:user", "run"),
      user("Next", undefined, "next:user"),
    ];
    const state = idle({
      chatRunId: "run",
      chatStream: "Partial",
      chatStreamStartedAt: 1,
    });
    const materialized = materialize(messages, state);
    expectTexts(materialized, "Original", "Steer", "Partial", "Next");
    const terminal = rememberLiveTerminalRun({ role: "assistant", content: "Complete" }, "run");
    expectTexts(
      appendTerminalAssistantMessage(materialized, terminal),
      "Original",
      "Steer",
      "Complete",
      "Next",
    );
  });

  it("retains commentary boundaries with a paged input", () => {
    const messages = [user("Steer", 50, "steer:user", "run")];
    const state = idle({
      chatRunId: "run",
      chatStreamSegments: [
        { runId: "run", itemId: "before", text: "Before", ts: 100, afterUserSendId: "run" },
        { runId: "run", itemId: "after", text: "After", ts: 0, afterUserSendId: "steer" },
      ],
    });
    expectTexts(materialize(messages, state), "Before", "Steer", "After");
  });

  it("preserves reused commentary from another run before the user boundary loads", () => {
    const persisted = {
      role: "assistant",
      content: [{ type: "text", text: "Saved commentary" }],
      timestamp: 1,
      __openclaw: { id: "saved", seq: 1, runId: "run-other" },
      openclawStreamFallback: { itemId: "shared-item", source: "segment" },
    };
    const segment = streamSegment("Current commentary", 2, {
      itemId: "shared-item",
      runId: "run-active",
    });
    const state = idle({ chatRunId: "run-active", chatStreamSegments: [segment] });
    expectTexts(materialize([persisted], state), "Saved commentary", "Current commentary");
    prunePersistedAssistantStreamSegments(state, persisted);
    expect(state.chatStreamSegments).toEqual([segment]);
  });

  it("does not replay a keyed preamble across a same-run steer boundary", () => {
    const state = idle({
      chatRunId: "active-run",
      chatStreamSegments: [
        streamSegment("already visible", 2, { itemId: "preamble-1", runId: "active-run" }),
        streamSegment("distinct item", 4, { itemId: "preamble-2", runId: "active-run" }),
        streamSegment("already visible", 5, { runId: "active-run" }),
      ],
    });
    const messages = [
      user("original ask", 1, "active-run:user"),
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
      user("steer this run", 3, "steer-run:user", "active-run"),
    ];

    const next = materialize(messages, state);

    expectTexts(
      next,
      "original ask",
      "already visible",
      "steer this run",
      "distinct item",
      "already visible",
    );
  });

  it("does not prune keyed preambles by live tool index", () => {
    const identity = buildToolStreamIdentity("run-active", "call_1");
    const state = idle({
      chatStreamSegments: [
        streamSegment("keyed preamble", 2, { itemId: "preamble-1" }),
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
    const state = idle({
      chatStreamSegments: [
        streamSegment("Before steer.", 1, { runId: "active-run" }),
        streamSegment("Before steer. After steer.", 2, { runId: "active-run" }),
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

  it.each([true, false])(
    "reconciles colliding call IDs only with run ownership (scoped=%s)",
    (scoped) => {
      const { state, toolCallId, foregroundIdentity, backgroundIdentity, foregroundMessage } =
        createConcurrentToolStreamState();
      const result = {
        role: "toolResult",
        toolCallId,
        content: scoped ? "background complete" : "unscoped output",
        ...(scoped ? { runId: "run-background" } : {}),
      };
      const persisted = persistedCurrentToolStreamIds([user("latest ask", 1), result], state);
      expect(persisted).toEqual(new Set(scoped ? [backgroundIdentity] : []));
      prunePersistedToolStreamMessages(state, persisted);
      expect(state.toolStreamOrder).toEqual(
        scoped ? [foregroundIdentity] : [foregroundIdentity, backgroundIdentity],
      );
      expect(state.toolStreamById.has(foregroundIdentity)).toBe(true);
      expect(state.toolStreamById.has(backgroundIdentity)).toBe(!scoped);
      expect(state.toolStreamById.size).toBe(scoped ? 1 : 2);
      if (scoped) {
        expect(state.chatToolMessages).toEqual([foregroundMessage]);
        expect(
          visibleAssistantStreamParts(state, { ...visibleStreamOptions, includeCurrent: false }),
        ).toMatchObject([{ text: "before foreground", runId: "run-foreground", toolCallId }]);
      } else {
        expect(state.chatToolMessages).toHaveLength(2);
        expect(state.chatStreamSegments).toHaveLength(2);
      }
    },
  );

  it("reconciles a whitespace call ID through its serialized live identity", () => {
    const toolCallId = " ";
    const runId = "run-live";
    const identity = buildToolStreamIdentity(runId, toolCallId);
    const state = idle({
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
      { role: "toolResult", toolCallId: "call_1", toolName: "shell" },
      { role: "tool", tool_call_id: "call_2", tool_name: "shell" },
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
    const state = idle({
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
    const userA = user("Run A", 1, "run-a:user");
    const fallbackA = materializeVisibleStreamState(
      [userA],
      idle({
        chatRunId: "run-a",
        chatStream: "Interrupted A",
        chatStreamStartedAt: 2,
      }),
      visibleStreamOptions,
    )[1];
    const userB = user("Run B", 3, "run-b:user");
    const terminalB = rememberLiveTerminalRun(assistant("Finished B", 4), "run-b");

    const next = appendTerminalAssistantMessage([userA, fallbackA, userB], terminalB);

    expectTexts(next, "Run A", "Interrupted A", "Run B", "Finished B");
  });

  it("reconciles a stream segment only inside its persisted ordinary-user interval", () => {
    const state = idle({
      chatStream: "Before steer. After steer.",
      chatStreamStartedAt: 4,
      chatStreamSegments: [streamSegment("Before steer.", 3, { runId: "active-run" })],
    });
    const messages = [
      user("Original prompt", 2, "active-run:user"),
      {
        role: "assistant",
        content: "Before steer.",
        timestamp: 100,
        __openclaw: { idempotencyKey: "active-run" },
      },
      user("Steer prompt", 1, "steer-run:user"),
    ];

    expect(historyReplacedVisibleStream(messages, state, visibleStreamOptions)).toBe(false);
    expectTexts(
      materialize(messages, state, { includeCurrent: false }),
      "Original prompt",
      "Before steer.",
      "Steer prompt",
    );
  });

  it("does not treat matching terminal text as a keyed preamble replacement", () => {
    const state = idle({
      chatStreamSegments: [streamSegment("before tool", 2, { itemId: "preamble-1" })],
    });
    const terminalMessage = assistant("before tool\nfinal answer", 3);
    const messages = [user("latest ask", 1), terminalMessage];

    expect(historyReplacedVisibleStream(messages, state, visibleStreamOptions)).toBe(false);
    const materialized = materialize(messages.slice(0, 1), state, {
      replacementMessages: [terminalMessage],
      includeCurrent: false,
    });
    expectTexts(materialized, "latest ask", "before tool");
    expectTexts(
      appendTerminalAssistantMessage(materialized, terminalMessage),
      "latest ask",
      "before tool",
      "before tool\nfinal answer",
    );
  });

  it("does not require transient keyed commentary to be present in history", () => {
    const state = idle({
      chatStreamSegments: [streamSegment("before tool", 2, { itemId: "preamble-1" })],
    });
    const messages = [user("latest ask", 1), assistant("final answer", 3)];

    expect(
      historyReplacedVisibleStream(messages, state, {
        ...visibleStreamOptions,
        persistCommentary: false,
      }),
    ).toBe(true);
  });

  it("still materializes the current stream tail when persistCommentary is false", () => {
    const state = idle({
      chatStream: "draft answer",
      chatStreamStartedAt: 3,
      chatStreamSegments: [streamSegment("transient preamble", 2, { itemId: "preamble-1" })],
    });
    const messages = [user("latest ask", 1)];

    const next = materialize(messages, state, { persistCommentary: false });

    expectTexts(next, "latest ask", "draft answer");
  });

  it("sequentially consumes incremental tool fallbacks before one terminal", () => {
    const state = idle({
      chatRunId: "active-run",
      chatStreamSegments: [
        { text: "A", ts: 2, runId: "active-run", toolCallId: "call-a" },
        { text: "A B", ts: 3, runId: "active-run", toolCallId: "call-b" },
      ],
    });
    const messages = [user("latest ask", 1, "active-run:user")];
    const materialized = materialize(messages, state);
    const terminal = rememberLiveTerminalRun(assistant("A B Final", 4), "active-run");

    const next = appendTerminalAssistantMessage(materialized, terminal);

    expectTexts(next, "latest ask", "A B Final");
  });
});
