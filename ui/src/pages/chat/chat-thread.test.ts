// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { prependUniqueNativeMessages } from "../../lib/chat/history-message-identity.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import * as toolCards from "../../lib/chat/tool-cards.ts";
import { coalesceAgentRunFrames } from "./chat-agent-run-grouping.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import {
  groupMessages,
  type WorkGroupRenderItem as WorkGroupItem,
} from "./chat-thread-grouping.ts";
import * as threadItems from "./chat-thread-items.ts";
import { buildItems, createProps, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import {
  buildCachedChatItems,
  coalesceStreamRuns,
  collapseCompletedTurnWork,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  persistedMessageEntryId,
  readPendingSendStatus,
  resetChatThreadState,
  setExpansionState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";
import { publishChatSessionProjectionMessages } from "./history-merge.ts";
import { rememberLiveTerminalRun } from "./terminal-message-identity.ts";
import { resolveChatProjectionRunId } from "./tool-stream-status.ts";

const { extractToolCardsCached: extractToolCards } = toolCards;

function preparedGroup(key: string, message: unknown): MessageGroup {
  return requireGroup(groupMessages([{ kind: "message", key, message }])[0]);
}

type ChatQueueItem = NonNullable<CachedChatItemsProps["queue"]>[number];

// Display fixtures need provenance markers for inbound-metadata stripping.
const SENDER_METADATA_BLOCK = `${markInboundContextLabel("Sender:")}\n\`\`\`json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n\`\`\``;

function chatMessage(
  role: string,
  content: unknown,
  timestamp?: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    role,
    content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...overrides,
  };
}

function userMessage(
  content: unknown,
  timestamp?: number,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return chatMessage("user", content, timestamp, overrides);
}

function assistantMessage(
  content: unknown,
  timestamp?: number,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return chatMessage("assistant", content, timestamp, overrides);
}

function senderProfile(id: string, name: string) {
  return { senderId: id, senderName: name, senderIdentity: { type: "profile", id } };
}

function toolUseMessage(
  id: string,
  name: string,
  input: unknown,
  timestamp: number,
): Record<string, unknown> {
  return assistantMessage([{ type: "tool_use", id, name, input }], timestamp);
}

function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: unknown,
  timestamp: number,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return chatMessage("toolResult", content, timestamp, { toolCallId, toolName, ...overrides });
}

function toolMessage(
  toolCallId: string,
  toolName: string,
  content: unknown,
  timestamp: number,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  return chatMessage("tool", content, timestamp, { toolCallId, toolName, ...overrides });
}

it("invalidates cached custody notices when workspace sync ownership changes", () => {
  const pendingInputs = [
    {
      acceptedAt: 1,
      id: "pending-follow-up",
      message: userMessage("continue", 1),
      runId: "follow-up-run",
      state: "queued" as const,
    },
  ];
  const input = createProps({ pendingInputs });
  const waiting = buildCachedChatItems({
    ...input,
    workspaceSyncPendingRunIds: ["follow-up-run"],
  });
  const active = buildCachedChatItems(input);

  expect(waiting.filter((item) => item.kind === "notice").map((item) => item.text)).toEqual([
    "Received · waiting for workspace sync",
  ]);
  expect(active.filter((item) => item.kind === "notice")).toEqual([]);
});

function queuedSend(
  id: string,
  text: string,
  createdAt: number,
  sendState: ChatQueueItem["sendState"],
  overrides: Partial<ChatQueueItem> = {},
): ChatQueueItem {
  return { id, text, createdAt, sendState, ...overrides };
}

function resetMessage(id: string) {
  return {
    role: "system",
    timestamp: 2_000,
    __openclaw: { kind: "reset", id },
  };
}

function canvasToolOutput(viewId: string, title: string, preferredHeight: number): string {
  return JSON.stringify({
    kind: "canvas",
    view: {
      backend: "canvas",
      id: viewId,
      url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      title,
      preferred_height: preferredHeight,
    },
    presentation: { target: "assistant_message" },
  });
}

function messageGroups(props: Partial<CachedChatItemsProps>): MessageGroup[] {
  return buildCachedChatItems(createProps(props)).filter((item) => item.kind === "group");
}

function firstMessageContent(group: MessageGroup): unknown[] {
  const message = group.messages[0]?.message as { content?: unknown };
  return Array.isArray(message.content) ? message.content : [];
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function requireGroup(value: unknown): MessageGroup {
  const record = requireRecord(value);
  expect(record.kind).toBe("group");
  return value as MessageGroup;
}

function groupAt(groups: readonly MessageGroup[], index: number): MessageGroup {
  return expectDefined(groups[index], `message group ${index}`);
}

function messageAt(group: MessageGroup, index: number) {
  return expectDefined(group.messages[index], `message ${index} in group ${group.key}`);
}

function messageRecord(group: MessageGroup, index = 0): Record<string, unknown> {
  return requireRecord(group.messages[index]?.message);
}

describe("assistant commentary grouping", () => {
  it("keeps later target-run tool output after an accepted steer", () => {
    const toolCallId = "call-after-steer";
    const items = buildItems({
      runId: "active-run",
      messages: [
        userMessage("Original", 1, {
          __openclaw: { idempotencyKey: "original-submit:user", runId: "active-run" },
        }),
        userMessage("Steer", 2, {
          __openclaw: {
            idempotencyKey: "steer-run:user",
            steerTargetRunId: "active-run",
          },
        }),
      ],
      streamSegments: [
        {
          text: "After steer",
          ts: 3,
          runId: "active-run",
          toolCallId,
        },
      ],
      toolMessages: [
        toolResultMessage(toolCallId, "shell", "Tool after steer", 4, {
          runId: "active-run",
        }),
      ],
    });
    const itemText = (item: (typeof items)[number]) =>
      item.kind === "stream"
        ? item.text
        : item.kind === "group"
          ? item.messages.map(({ message }) => JSON.stringify(message)).join(" ")
          : "";
    const steerIndex = items.findIndex((item) => itemText(item).includes("Steer"));
    const segmentIndex = items.findIndex((item) => itemText(item).includes("After steer"));
    const toolIndex = items.findIndex((item) => itemText(item).includes("Tool after steer"));

    expect(steerIndex).toBeGreaterThan(-1);
    expect(toolIndex).toBeGreaterThan(-1);
    expect(segmentIndex).toBeGreaterThan(steerIndex);
    expect(toolIndex).toBeGreaterThan(segmentIndex);
  });

  const reconnectingSend = queuedSend(
    "reconnecting-send",
    "Current prompt",
    2_000,
    "waiting-reconnect",
    { sendAttempts: 1, sendRunId: "run-restored" },
  );
  it.each([
    {
      name: "run-owned replay stays inside its older turn",
      props: {
        runId: "run-current",
        messages: [
          userMessage("Earlier prompt", 1_000, {
            __openclaw: { idempotencyKey: "earlier-submit:user", runId: "run-earlier" },
          }),
          assistantMessage("Earlier reply", 1_300),
          userMessage("Current prompt", 2_000, {
            __openclaw: { idempotencyKey: "current-submit:user", runId: "run-current" },
          }),
        ],
        streamSegments: [
          { text: "Earlier commentary", ts: 500, runId: "run-earlier", itemId: "earlier" },
          { text: "Current commentary", ts: 1_200, runId: "run-current", itemId: "current" },
        ],
        toolMessages: [
          toolResultMessage("call-earlier", "shell", "Earlier tool output", 3_000, {
            runId: "run-earlier",
          }),
        ],
      },
      order: ["user", "stream", "assistant", "tool", "user", "stream"],
    },
    {
      name: "unmatched legacy replay retains timestamp placement across older turns",
      props: {
        runId: "run-current",
        messages: [
          userMessage("First prompt", 1_000),
          assistantMessage("First reply", 1_300),
          userMessage("Second prompt", 2_000),
          assistantMessage("Second reply", 2_300),
          userMessage("Current prompt", 3_000),
        ],
        toolMessages: [
          toolResultMessage("call-legacy", "shell", "Legacy tool output", 1_100, {
            runId: "legacy-unmatched-run",
          }),
        ],
      },
      order: ["user", "tool", "assistant", "user", "assistant", "user"],
    },
    {
      name: "restored reconnect prompt precedes its active server tool projection",
      props: {
        runId: resolveChatProjectionRunId({
          activeRunIds: ["run-restored"],
          queue: [reconnectingSend],
        }),
        queue: [reconnectingSend],
        toolMessages: [
          toolResultMessage("call-restored", "shell", "Restored tool output", 1_000, {
            runId: "run-restored",
          }),
        ],
      },
      order: ["user", "tool"],
    },
  ] satisfies { name: string; props: Partial<CachedChatItemsProps>; order: string[] }[])(
    "$name",
    ({ props, order }) => {
      expect(
        buildItems(props).map((item) => (item.kind === "group" ? item.role : item.kind)),
      ).toEqual(order);
    },
  );

  it.each([
    { source: "live terminal", sendState: "sending", search: false, active: true },
    { source: "durable reply", sendState: "sending", search: true, active: true },
    { source: "durable reply", sendState: "waiting-reconnect", search: false, active: false },
  ] as const)(
    "keeps a $sendState prompt before its $source under clock skew with search=$search active=$active",
    ({ source, sendState, search, active }) => {
      const paneId = `reply-before-user:${source}:${sendState}:${search}:${active}`;
      const terminal =
        source === "live terminal"
          ? rememberLiveTerminalRun(assistantMessage("Current reply", 1_000), "run-active")
          : assistantMessage("Current reply", 1_000, {
              __openclaw: { id: "durable-reply", seq: 6, runId: "run-active" },
            });
      const preceding = [
        userMessage("Earlier prompt", 500),
        assistantMessage("Unowned reply", 4_000),
        assistantMessage("Unrelated reply", 300, { __openclaw: { runId: "other-run" } }),
        assistantMessage("Imported reply", 2_500, {
          __openclaw: {
            importedFrom: "claude-cli",
            cliSessionId: "external-session",
            externalId: "external-reply",
            runId: "run-active",
          },
        }),
        assistantMessage("Unattributed run hint", 900, { runId: "run-active" }),
      ];
      if (search) {
        preceding.push(
          assistantMessage("Hidden earlier output", 950, {
            __openclaw: { id: "hidden-output", seq: 5, runId: "run-active" },
          }),
        );
      }
      const sending = queuedSend("sending-current", "Current prompt", 2_000, sendState, {
        sendAttempts: 1,
        sendRunId: "run-active",
      });
      const liveItems = buildItems({
        paneId,
        runId: active ? "run-active" : null,
        searchOpen: search,
        searchQuery: "Current",
        messages: [...preceding, terminal],
        queue: [
          sending,
          ...(search
            ? [queuedSend("unrelated", "Other prompt", 3_000, "sending", { sendAttempts: 1 })]
            : []),
        ],
      });
      const stableItems = buildItems({
        paneId,
        searchOpen: search,
        searchQuery: "Current",
        messages: [
          ...preceding,
          userMessage([{ type: "text", text: "Current prompt" }], 2_000, {
            __openclaw: { idempotencyKey: "run-active:user" },
          }),
          terminal,
        ],
      });
      const messages = (items: ReturnType<typeof buildCachedChatItems>) =>
        items.flatMap((item) =>
          item.kind === "group" ? item.messages.map(({ message }) => message) : [],
        );

      resetChatThreadState(paneId);
      const expected = [
        ...(search ? [] : preceding),
        expect.objectContaining({
          role: "user",
          content: [{ type: "text", text: "Current prompt" }],
        }),
        terminal,
      ];
      expect(messages(liveItems)).toEqual(expected);
      expect(messages(stableItems)).toEqual(expected);
    },
  );

  it("hides durable commentary when the display preference is disabled", () => {
    const paneId = "commentary-visibility";
    const messages = [
      userMessage("do it", 1_000),
      assistantMessage("Checking the workspace.", 2_000, {
        openclawStreamFallback: {
          replacementText: "Checking the workspace.",
          source: "segment",
          itemId: "preamble-1",
        },
      }),
      assistantMessage("All done.", 3_000),
    ];

    const visible = buildItems({ paneId, messages });
    const hidden = buildItems({ paneId, messages, persistCommentary: false });
    const restored = buildItems({ paneId, messages });

    expect(visible.filter((item) => item.kind === "group")).toHaveLength(3);
    expect(hidden.filter((item) => item.kind === "group")).toHaveLength(2);
    expect(restored.filter((item) => item.kind === "group")).toHaveLength(3);
    expect(messages).toHaveLength(3);
    resetChatThreadState(paneId);
  });
});

describe("collapseCompletedTurnWork", () => {
  const collapsedItems = (props: Partial<CachedChatItemsProps>, runWorking = false) =>
    collapseCompletedTurnWork(coalesceStreamRuns(buildCachedChatItems(createProps(props))), {
      sessionKey: "agent:main:dashboard:test-session",
      runWorking,
    });

  function requireWorkGroup(value: unknown): WorkGroupItem {
    const record = requireRecord(value);
    expect(record.kind).toBe("work-group");
    return value as WorkGroupItem;
  }

  const toolResult = (id: string, timestamp: number, isError = false) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    isError,
    content: isError ? "boom" : "ok",
    timestamp,
  });

  it.each([
    {
      name: "durable context event retains surrounding replies",
      message: {
        role: "custom",
        customType: "openclaw.context-compaction",
        content: "Context compacted",
        display: true,
        excludeFromContext: true,
        details: { runId: "run-1" },
        idempotencyKey: "codex-context-compaction:thread:turn:item",
        timestamp: 2_000,
      },
      surrounding: true,
      divider: { compaction: "complete", label: "Context compacted" },
    },
    {
      name: "persisted boundary retains recorded token savings",
      message: {
        role: "system",
        timestamp: 2_000,
        __openclaw: {
          kind: "compaction",
          id: "checkpoint-with-metrics",
          tokensBefore: 900_000,
          tokensAfter: 24_700,
        },
      },
      surrounding: false,
      divider: { kind: "divider", label: "Context compacted", metric: "saved 875.3k tokens" },
    },
  ])("renders a compaction marker when $name", ({ message, surrounding, divider }) => {
    const items = collapsedItems({
      messages: surrounding
        ? [userMessage("do it", 1_000), message, assistantMessage("All done.", 3_000)]
        : [message],
    });
    expect(items[surrounding ? 1 : 0]).toMatchObject(divider);
    if (surrounding) {
      expect(items.map((item) => item.kind)).toEqual(["group", "divider", "group"]);
      expect(requireGroup(items[2]).messages[0]?.message).toMatchObject({ content: "All done." });
    }
  });

  it("keeps a tool visualization visible while collapsing its work", () => {
    const items = collapsedItems({
      messages: [
        userMessage("show the result", 1_000),
        toolResultMessage(
          "visualization",
          "show_widget",
          [mcpAppCanvasBlock("completed-turn", "visualization")],
          2_000,
        ),
        assistantMessage("Checking the details.", 2_500),
        toolResult("call-1", 3_000),
        assistantMessage("All done.", 4_000),
      ],
    });
    expect(items.map((item) => item.kind)).toEqual(["group", "work-group", "group", "group"]);
    expect(canvasBlocksIn(requireGroup(items[2]))).toHaveLength(1);
    expect(requireWorkGroup(items[1]).groups.map((group) => group.role)).toEqual([
      "assistant",
      "tool",
    ]);
    expect(messageRecord(requireGroup(items[3])).content).toBe("All done.");
  });

  it("keeps completed work expanded for non-dashboard session", () => {
    const sessionKey = "agent:main::dashboard:malformed";

    const items = coalesceStreamRuns(
      buildItems({
        sessionKey,
        messages: [
          userMessage("do it", 1_000),
          assistantMessage("Checking…", 2_000),
          toolResult("call-1", 3_000),
          assistantMessage("All done.", 10_000),
        ],
      }),
    );

    const rendered = collapseCompletedTurnWork(items, { sessionKey, runWorking: false });

    expect(rendered.map((item) => item.kind)).toEqual(["group", "group", "group", "group"]);
  });

  it("does not borrow an unscoped answer across a queued message from a peer", () => {
    const messages = [
      userMessage("do it", 1_000, {
        __openclaw: { idempotencyKey: "active-run:user", senderId: "operator" },
      }),
      assistantMessage("Checking…", 2_000),
      toolResult("call-1", 3_000),
      userMessage("queued follow-up", 3_500, {
        __openclaw: { idempotencyKey: "queued-run:user", senderId: "peer" },
      }),
      userMessage("continue", 4_000, {
        __openclaw: {
          idempotencyKey: "steer-run:user",
          senderId: "operator",
          steerTargetRunId: "active-run",
        },
      }),
      assistantMessage("All done.", 5_000),
    ];

    expect(
      collapsedItems({ messages, runWorking: true }, true).some(
        (item) => item.kind === "work-group",
      ),
    ).toBe(false);

    const completed = collapsedItems({ messages });
    expect(completed.map((item) => item.kind)).toEqual([
      "group",
      "work-group",
      "group",
      "group",
      "group",
      "group",
    ]);
    expect(
      requireWorkGroup(completed[1]).groups.flatMap((group) =>
        group.messages.map(({ message }) => message),
      ),
    ).toEqual([messages[2]]);
    expect(
      completed.flatMap((item) =>
        item.kind === "group" ? item.messages.map(({ message }) => message) : [],
      ),
    ).toEqual([messages[0], messages[1], messages[3], messages[4], messages[5]]);
  });

  it.each([
    {
      name: "structured error",
      isError: true,
      result: { content: [{ type: "tool_result", isError: true, text: "boom" }] },
    },
    {
      name: "inferred error",
      isError: true,
      result: { content: '{"status":"error","error":"boom"}' },
    },
    {
      name: "explicit success overrides error-shaped output",
      isError: false,
      result: { isError: false, content: '{"error":"example"}' },
    },
  ])("keeps trailing work in the disclosure unless it failed ($name)", ({ isError, result }) => {
    const trailing = { ...toolResult("call-2", 4_000), isError: undefined, ...result };
    const items = collapsedItems({
      messages: [
        userMessage("go", 1_000),
        toolResult("call-1", 2_000),
        assistantMessage("Done.", 3_000),
        trailing,
      ],
    });

    expect(items.map((item) => item.kind)).toEqual(
      isError ? ["group", "work-group", "group", "group"] : ["group", "work-group", "group"],
    );
    const work = requireWorkGroup(items[1]);
    expect(work.groups).toHaveLength(isError ? 1 : 2);
    if (isError) {
      expect(requireGroup(items[3]).messages.map(({ message }) => message)).toContain(trailing);
    } else {
      expect(work.durationMs).toBeNull();
    }
  });

  it("collapses a trailing failure only after a subsequent answer", () => {
    const failed = toolResult("failed", 4_000, true);
    const messages = [
      userMessage("go", 1_000),
      assistantMessage("First result.", 2_000),
      failed,
      {
        ...assistantMessage("Checking the failure.", 5_000),
        content: [
          {
            type: "text",
            text: "Checking the failure.",
            textSignature: JSON.stringify({ v: 1, id: "checking", phase: "commentary" }),
          },
        ],
      },
      toolResult("supplementary", 6_000),
    ];
    const idle = collapsedItems({ messages });
    expect(
      idle
        .filter((item) => item.kind === "group")
        .flatMap((group) => group.messages.map(({ message }) => message)),
    ).toContain(failed);
    const recovered = collapsedItems({
      messages: [...messages, assistantMessage("Recovered via another route.", 7_000)],
    });
    expect(
      recovered
        .filter((item) => item.kind === "group")
        .flatMap((group) => group.messages.map(({ message }) => message)),
    ).not.toContain(failed);
    expect(
      requireWorkGroup(recovered[1]).groups.flatMap((group) =>
        group.messages.map(({ message }) => message),
      ),
    ).toContain(failed);
  });

  it("collapses hidden-input runs independently without changing duration arithmetic", () => {
    const items = collapsedItems({
      messages: [
        userMessage("[System] Resume work.", 0, {
          provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
        }),
        {
          ...toolResult("call-1", 1_000),
          __openclaw: { id: "work-1", seq: 1, turnBoundary: true },
        },
        assistantMessage("First run done.", 3_000, {
          __openclaw: { id: "reply-1", seq: 2 },
        }),
        {
          ...toolResult("call-2", 4_000),
          __openclaw: { id: "work-2", seq: 3, turnBoundary: true },
        },
        assistantMessage("Second run done.", 9_000, {
          __openclaw: { id: "reply-2", seq: 4 },
        }),
      ],
    });

    expect(items.map((item) => item.kind)).toEqual([
      "notice",
      "work-group",
      "group",
      "work-group",
      "group",
    ]);
    expect(requireWorkGroup(items[1]).key).not.toBe(requireWorkGroup(items[3]).key);
    expect(requireWorkGroup(items[1]).durationMs).toBeNull();
    expect(requireWorkGroup(items[3]).durationMs).toBeNull();
  });
});

describe("buildCachedChatItems row identity", () => {
  it("preserves a same-role group key as messages are prepended and appended", () => {
    resetChatThreadState();
    const first = assistantMessage("First", 2, { __openclaw: { id: "assistant-1", seq: 2 } });
    const second = assistantMessage("Second", 3, { __openclaw: { id: "assistant-2", seq: 3 } });
    const initial = groupAt(messageGroups({ messages: [first, second] }), 0);
    const prepended = groupAt(
      messageGroups({
        messages: [
          assistantMessage("Earlier", 1, { __openclaw: { id: "assistant-0", seq: 1 } }),
          first,
          second,
        ],
      }),
      0,
    );
    const appended = groupAt(
      messageGroups({
        messages: [
          ...prepended.messages.map((entry) => entry.message),
          assistantMessage("Later", 4, { __openclaw: { id: "assistant-3", seq: 4 } }),
        ],
      }),
      0,
    );

    expect(prepended.key).toBe(initial.key);
    expect(appended.key).toBe(initial.key);
  });

  it("does not reclaim a group key naturally owned by another reordered group", () => {
    resetChatThreadState();
    const first = userMessage("First", 1, {
      __openclaw: { id: "first", seq: 1 },
      senderLabel: "same",
    });
    const second = userMessage("Second", 2, {
      __openclaw: { id: "second", seq: 2 },
      senderLabel: "same",
    });
    expect(messageGroups({ messages: [first, second] })).toHaveLength(1);

    const replacement = { ...first, senderLabel: "different", timestamp: 3 };
    const regrouped = messageGroups({ messages: [replacement, second] });

    expect(regrouped).toHaveLength(2);
    expect(new Set(regrouped.map((group) => group.key)).size).toBe(regrouped.length);
  });
});

describe("buildCachedChatItems working spark", () => {
  const readingIndicator = (props: Partial<CachedChatItemsProps>) =>
    buildCachedChatItems(createProps(props)).find((item) => item.kind === "reading-indicator");
  it("keeps one working row from optimistic send through acknowledgement", () => {
    resetChatThreadState();
    const sessionKey = "agent:main:working-row";
    const failed = queuedSend("failed", "Earlier failure", 0, "failed", {
      sendRunId: "failed-run",
      sendAttempts: 1,
      sendError: "Rejected",
    });
    const project = (props: Partial<CachedChatItemsProps>) => {
      const items = buildItems({ sessionKey, runWorking: true, queue: [failed], ...props });
      const runs = coalesceStreamRuns(items);
      return {
        items,
        indicator: expectDefined(
          items.find((item) => item.kind === "reading-indicator"),
          "indicator",
        ),
        run: expectDefined(
          runs.find((item) => item.kind === "stream-run"),
          "stream run",
        ),
        frame: expectDefined(
          coalesceAgentRunFrames(runs).find((item) => item.kind === "agent-run-frame"),
          "agent frame",
        ),
      };
    };
    const pending = project({
      queue: [
        failed,
        queuedSend("queued-send-1", "keep the row stable", 1_000, "sending", {
          sendRunId: "run-1",
          sendSubmittedAtMs: 10,
        }),
      ],
    });
    const acknowledged = project({ runId: "run-1", stream: "", streamStartedAt: 2_000 });
    expect(pending.indicator.startedAt).toBe(1_000);
    expect(acknowledged.indicator).toMatchObject({
      key: pending.indicator.key,
      startedAt: pending.indicator.startedAt,
    });
    expect(acknowledged.run.key).toBe(pending.run.key);
    expect(acknowledged.frame.key).toBe(pending.frame.key);
    const reconnected = project({
      runId: "run-1",
      streamSegments: [{ text: "Working", ts: 3_000, runId: "run-1" }],
    });
    expect(reconnected.indicator).toMatchObject({
      key: pending.indicator.key,
      runId: "run-1",
      startedAt: 1_000,
    });

    const streaming = project({
      runId: "run-1",
      stream: "The reply has started.",
      streamStartedAt: 2_000,
    });
    const stream = expectDefined(
      streaming.items.find((item) => item.kind === "stream" && item.isStreaming),
      "live stream",
    );
    expect(stream.key).toBe(pending.indicator.key);
    expect(streaming.indicator.key).toBe(pending.indicator.key);
    expect(streaming.run).toMatchObject({
      key: pending.run.key,
      parts: [{ kind: "stream" }, { kind: "reading-indicator" }],
    });
    const next = project({ runId: "run-2", stream: "", streamStartedAt: 3_000 });
    const other = project({
      sessionKey: "agent:other:working-row",
      runId: "run-1",
      stream: "",
      streamStartedAt: 2_000,
    });
    expect(next.indicator.key).not.toBe(pending.indicator.key);
    expect(next.indicator.startedAt).toBe(3_000);
    expect(other.indicator.key).not.toBe(pending.indicator.key);
    expect(readingIndicator({ sessionKey, queue: [failed] })).toBeUndefined();
  });

  it("yields to the initial-load skeleton on an empty thread", () => {
    expect(readingIndicator({ runWorking: true, loading: true })).toBeUndefined();
  });
});

describe("buildCachedChatItems", () => {
  it("reuses absent canvas previews through older-page merges and invalidates replacements", () => {
    const output = JSON.stringify({ exitCode: 0, output: "current" });
    const current = toolResultMessage("current-call", "custom", output, 2, {
      __openclaw: { id: "current" },
    });
    const olderOutput = JSON.stringify({ exitCode: 0, output: "older" });
    const older = toolResultMessage("older-call", "custom", olderOutput, 1, {
      __openclaw: { id: "older" },
    });
    const owner = { sessionKey: "preview-pages", chatMessages: [current] as unknown[] };
    const prepare = vi.spyOn(toolCards, "extractToolPreview");
    const rebuild = () =>
      buildItems({ paneId: "preview-pages", messages: [...owner.chatMessages] });
    try {
      rebuild();
      rebuild();
      expect(prepare.mock.calls.filter(([text]) => text === output)).toHaveLength(1);
      publishChatSessionProjectionMessages(
        owner,
        prependUniqueNativeMessages([older, { ...current }], owner.chatMessages),
      );
      expect(owner.chatMessages).toHaveLength(2);
      expect(owner.chatMessages[1]).toBe(current);
      rebuild();
      expect(prepare.mock.calls.filter(([text]) => text === output)).toHaveLength(1);
      expect(prepare.mock.calls.filter(([text]) => text === olderOutput)).toHaveLength(1);
      publishChatSessionProjectionMessages(owner, [older, { ...current }]);
      rebuild();
      expect(prepare.mock.calls.filter(([text]) => text === output)).toHaveLength(2);
    } finally {
      prepare.mockRestore();
      resetChatThreadState("preview-pages");
    }
  });

  it("does not inspect ordinary transcript messages for tool previews", () => {
    const messages = [userMessage("hello", 1_000), assistantMessage("reply", 1_001)];
    const previewExtraction = vi.spyOn(threadItems, "extractChatMessagePreview");
    try {
      buildItems({ paneId: "ordinary-transcript", messages });

      expect(previewExtraction).not.toHaveBeenCalled();
    } finally {
      previewExtraction.mockRestore();
    }
  });

  it("sender provenance separates namespaces without splitting profile renames", () => {
    const groups = messageGroups({
      messages: [
        userMessage("first", 1000, {
          __openclaw: {
            ...senderProfile("shared", "Same"),
          },
        }),
        userMessage("second", 1001, {
          __openclaw: {
            ...senderProfile("shared", "Renamed"),
            senderProfileAvatarUrl: "/api/users/shared/avatar?v=2",
          },
        }),
        userMessage("third", 1002, {
          __openclaw: {
            senderId: "shared",
            senderName: "Renamed",
            senderProfileAvatarUrl: "/api/users/shared/avatar?v=2",
            senderIdentity: {
              type: "observation",
              id: "shared",
              pluginId: "channel",
              accountId: null,
              senderKind: "unknown",
            },
          },
        }),
      ],
    });
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.messages.length)).toEqual([2, 1]);
  });

  it("renders non-compaction system messages as notices and skips empty output", () => {
    const items = buildItems({
      messages: [
        { role: "system", content: "Command output\n  indented", timestamp: 1000 },
        { role: "system", content: "  \n", timestamp: 1001 },
      ],
    });

    expect(items).toEqual([
      {
        kind: "notice",
        key: expect.any(String),
        text: "Command output\n  indented",
        timestamp: 1000,
      },
    ]);
  });

  it("preserves mixed content in an earlier bundled result message", () => {
    const mixedContent = [
      { type: "text", text: "Keep this explanation" },
      { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
      { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
    ];
    const groups = messageGroups({
      messages: [
        userMessage(mixedContent, 1000),
        assistantMessage(
          [
            { type: "tool_use", id: "call-a", name: "read", input: { path: "a.ts" } },
            { type: "tool_use", id: "call-b", name: "read", input: { path: "b.ts" } },
          ],
          1001,
        ),
      ],
    });

    expect(groups).toHaveLength(1);
    const entries = groupAt(groups, 0).messages;
    expect(entries).toHaveLength(1);
    const cards = entries.flatMap((entry) => extractToolCards(entry.message));
    expect(cards.map((card) => [card.callId, card.args, card.outputText])).toEqual([
      ["call-a", { path: "a.ts" }, "contents of a"],
      ["call-b", { path: "b.ts" }, "contents of b"],
    ]);
    expect(firstMessageContent(groupAt(groups, 0))).toContainEqual(mixedContent[0]);
  });

  describe("distinct tool invocations", () => {
    const call = (id: string, name = "exec", runId: string | undefined = "run-a") =>
      assistantMessage([{ type: "toolCall", id, name, arguments: { command: "echo ready" } }], 10, {
        runId,
      });
    const result = (id: string, text = "ready", runId: string | undefined = "run-a") =>
      toolResultMessage(id, "exec", [{ type: "text", text }], 20, { runId });
    const canonical = ({ runId, ...message }: Record<string, unknown>, seq: number) => ({
      ...message,
      __openclaw: { id: `tool-entry-${seq}`, seq, runId },
    });
    const snapshot = (id: string, completed = true) =>
      assistantMessage(
        [
          { type: "toolcall", name: "exec", arguments: { command: "echo ready" } },
          { type: "toolresult", name: "exec", text: completed ? "ready" : "working" },
        ],
        10,
        {
          runId: "run-a",
          toolCallId: id,
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: completed,
        },
      );
    const cardsFor = (messages: unknown[], toolMessages: unknown[] = []) =>
      messageGroups({ messages, toolMessages }).flatMap((group) =>
        group.messages.flatMap((entry) => extractToolCards(entry.message)),
      );

    it("keeps a persisted empty terminal result over a partial snapshot", () => {
      const partial = snapshot("exec-1", false);
      expect(cardsFor([partial])[0]).toMatchObject({
        live: true,
        completed: false,
        outputText: "working",
      });
      const terminal = result("exec-1", "");
      const cards = cardsFor([terminal, partial]);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ completed: true, outputText: "" });
    });

    it.each([
      { completed: false, owner: "live" },
      { completed: true, owner: "canonical" },
    ])(
      "keeps one invocation before an optimistic steer ($owner ownership, completed=$completed)",
      ({ completed, owner }) => {
        const persisted = [call("exec-1"), ...(completed ? [result("exec-1")] : [])].map(
          (message, index) => (owner === "canonical" ? canonical(message, index + 2) : message),
        );
        const history = [
          userMessage("Original request", 1, {
            __openclaw: { id: "user-entry", seq: 1 },
          }),
          ...persisted,
          userMessage("Follow up after the command", 15, {
            __openclaw: { idempotencyKey: "steer-send:user" },
          }),
        ];
        const before = structuredClone(history);
        const groups = messageGroups({
          runId: "run-a",
          messages: history,
          toolMessages: [snapshot("exec-1", completed)],
        });
        const visible = groups.flatMap((group) =>
          group.messages.flatMap((entry) => {
            const cards = extractToolCards(entry.message);
            return cards.length ? cards : [requireRecord(entry.message).content];
          }),
        );

        expect(visible).toEqual([
          "Original request",
          expect.objectContaining({
            callId: "exec-1",
            completed,
            outputText: completed ? "ready" : "working",
          }),
          "Follow up after the command",
        ]);
        expect(history).toEqual(before);
      },
    );

    it.each(["unknown history run", "reset", "reused"])(
      "does not relocate a live invocation across a boundary with %s ownership",
      (ownership) => {
        const persisted = call("exec-1");
        const live = snapshot("exec-1", false);
        if (ownership === "unknown history run") {
          persisted.runId = undefined;
        }
        const groups = messageGroups({
          runId: "run-a",
          messages: [
            userMessage("Original request", 1),
            persisted,
            ...(ownership === "reset" ? [resetMessage("reset-invocation")] : []),
            userMessage("Next request", 15),
            ...(ownership === "reused" ? [call("exec-1")] : []),
          ],
          toolMessages: [live],
        });
        const cards = groups.flatMap((group) =>
          group.messages.flatMap((entry) => extractToolCards(entry.message)),
        );
        expect(cards).toHaveLength(2);
        expect(cards.filter((card) => card.outputText === "working")).toHaveLength(1);
      },
    );

    it("does not assign ambiguous unscoped history to a sibling run", () => {
      const unscoped = { ...result("shared", "unscoped"), runId: undefined };
      const scoped = [call("shared", "exec", "run-a"), call("shared", "exec", "run-b")];
      const cards = cardsFor([unscoped, ...scoped]);
      expect(cards).toHaveLength(3);
      expect(
        cards
          .filter((card) => card.args !== undefined)
          .every((card) => card.outputText === undefined),
      ).toBe(true);
    });

    it("reconciles a multi-call snapshot without losing surrounding content or result metadata", () => {
      const attachment = { type: "image", data: "fixture-image", mimeType: "image/png" };
      const history = assistantMessage(
        [
          { type: "text", text: "Before calls" },
          { type: "toolcall", id: "a", name: "exec", arguments: { command: "first" } },
          { type: "toolcall", id: "b", name: "exec", arguments: { command: "second" } },
          { type: "text", text: "After calls" },
        ],
        10,
        { runId: "run-a", __openclaw: { id: "transcript-call" } },
      );
      const terminal = result("a", "failed");
      terminal.content = [{ type: "text", text: "failed" }, attachment];
      terminal.details = { exitCode: 7, approvalReviewOutcome: "approved" };
      terminal.isError = true;
      const groups = messageGroups({
        messages: [history, terminal, result("b")],
        toolMessages: [snapshot("a"), snapshot("b")],
      });
      const entries = groups.flatMap((group) => group.messages);
      const cards = entries.flatMap((entry) => extractToolCards(entry.message));
      expect(cards).toHaveLength(2);
      expect(cards.find((card) => card.callId === "a")).toMatchObject({
        args: { command: "first" },
        outputText: "failed",
        isError: true,
        exitCode: 7,
        details: { exitCode: 7, approvalReviewOutcome: "approved" },
        messageId: "transcript-call",
      });
      const blocks = entries.flatMap((entry) => requireRecord(entry.message).content as unknown[]);
      expect(blocks).toContainEqual(attachment);
      expect(blocks).toContainEqual({ type: "text", text: "Before calls" });
      expect(blocks).toContainEqual({ type: "text", text: "After calls" });
      expect(
        blocks.findIndex((block) => requireRecord(block).text === "Before calls"),
      ).toBeLessThan(blocks.findIndex((block) => requireRecord(block).id === "a"));
      expect(
        blocks.findIndex((block) => requireRecord(block).text === "After calls"),
      ).toBeGreaterThan(blocks.findLastIndex((block) => requireRecord(block).id === "b"));
    });

    it("preserves typed terminal payload over partial text and keeps sibling completion independent", () => {
      const partial = assistantMessage(
        [
          { type: "toolcall", id: "a", name: "exec", arguments: { command: "one" } },
          { type: "toolresult", id: "a", name: "exec", text: "partial" },
          { type: "toolcall", id: "b", name: "exec", arguments: { command: "two" } },
          { type: "toolresult", id: "b", name: "exec", text: "still running" },
        ],
        10,
        {
          runId: "run-a",
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: false,
        },
      );
      const cards = cardsFor([
        partial,
        toolResultMessage("a", "exec", [{ type: "tool_result", content: "" }], 20, {
          runId: "run-a",
          messageId: "result-a",
          is_error: false,
          exit_code: 0,
        }),
      ]);
      expect(cards).toHaveLength(2);
      expect(cards[0]).toMatchObject({
        callId: "a",
        outputText: "",
        completed: true,
        messageId: "result-a",
        isError: false,
        exitCode: 0,
      });
      expect(cards[1]).toMatchObject({
        callId: "b",
        outputText: "still running",
        completed: false,
      });
    });

    it("keeps surrounding text in order when result references split a multi-call message", () => {
      const groups = messageGroups({
        messages: [
          assistantMessage(
            [
              { type: "text", text: "before" },
              { type: "toolcall", id: "a", name: "exec", arguments: {} },
              { type: "text", text: "between" },
              { type: "toolcall", id: "b", name: "exec", arguments: {} },
              { type: "text", text: "after" },
            ],
            10,
          ),
          { ...result("a"), messageId: "a-result" },
          { ...result("b"), __openclaw: { id: "b-result" } },
        ],
      });
      const content = groups.flatMap((group) =>
        group.messages.flatMap(
          (entry) => requireRecord(entry.message).content as Record<string, unknown>[],
        ),
      );
      expect(content.map((block) => (block.type === "text" ? block.text : block.id))).toEqual([
        "before",
        "a",
        "a",
        "between",
        "b",
        "b",
        "after",
      ]);
    });

    it("reconciles identified siblings without losing anonymous fallback pairs", () => {
      const cards = cardsFor(
        [
          assistantMessage(
            [
              { type: "toolcall", id: "a", name: "exec", arguments: { command: "one" } },
              { type: "toolresult", name: "exec", text: "one done" },
              { type: "toolcall", name: "exec", arguments: { command: "two" } },
              { type: "toolresult", name: "exec", text: "two done" },
            ],
            10,
          ),
        ],
        [snapshot("a")],
      );
      expect(cards).toHaveLength(2);
      expect(cards.map((card) => [card.callId, card.args, card.outputText])).toEqual([
        ["a", { command: "one" }, "one done"],
        [undefined, { command: "two" }, "two done"],
      ]);
    });

    it("keeps per-call live diffs and conflicting-name outputs independent inside a batch", () => {
      const live = ["a", "b"].map((id, index) =>
        Object.assign(snapshot(id, false), {
          __openclawToolStreamDiffStat: { added: index + 1, removed: 0 },
        }),
      );
      const cards = cardsFor(
        [
          assistantMessage(
            [
              { type: "toolcall", id: "a", name: "exec", arguments: {} },
              { type: "toolcall", id: "b", name: "exec", arguments: {} },
              { type: "toolcall", id: "conflict", name: "read", arguments: { path: "a" } },
              { type: "toolcall", id: "conflict", name: "exec", arguments: { command: "pwd" } },
            ],
            10,
            { runId: "run-a" },
          ),
          toolResultMessage("conflict", "read", "read output", 20, { runId: "run-a" }),
          result("conflict", "exec output"),
        ],
        live,
      );
      expect(cards).toHaveLength(4);
      expect(cards.slice(0, 2).map((card) => card.liveDiffStat)).toEqual([
        { added: 1, removed: 0 },
        { added: 2, removed: 0 },
      ]);
      expect(cards.slice(2).map((card) => [card.name, card.outputText])).toEqual([
        ["read", "read output"],
        ["exec", "exec output"],
      ]);
    });

    it.each([userMessage("new turn", 15), resetMessage("reset-counting")])(
      "does not coalesce through a user/reset boundary: %j",
      (boundary) => {
        expect(cardsFor([call("a"), boundary, result("a")])).toHaveLength(2);
      },
    );
  });

  it("keeps more than sixteen parallel calls open by call id", () => {
    const groups = messageGroups({
      messages: [
        ...Array.from({ length: 17 }, (_, index) =>
          toolUseMessage(`call-${index}`, "read", { path: `${index}.ts` }, 1000 + index),
        ),
        toolResultMessage("call-0", "read", [{ type: "text", text: "first contents" }], 1017),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groupAt(groups, 0).messages).toHaveLength(17);
    const cards = groupAt(groups, 0).messages.flatMap((entry) => extractToolCards(entry.message));
    expect(cards).toHaveLength(17);
    expect(cards.find((card) => card.callId === "call-0")).toMatchObject({
      outputText: "first contents",
    });
  });

  it.each([
    {
      name: "deduplicates relay copies by canonical identity before surface ids",
      relayText: "Parzival Ship it.",
      nativeText: "Ship it.",
      surfaceIds: true,
      expected: ["Ship it."],
    },
    {
      name: "keeps formatting-only updates separate for the same source message",
      relayText: "Parzival first\n\nsecond",
      nativeText: "first second",
      surfaceIds: false,
      expected: ["Parzival first\n\nsecond", "first second"],
    },
  ])("$name", ({ relayText, nativeText, surfaceIds, expected }) => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: relayText }], 1, {
          ...(surfaceIds ? { id: "relay-surface-copy" } : {}),
          __openclaw: { id: "reply" },
          senderLabel: "Parzival",
        }),
        assistantMessage([{ type: "text", text: nativeText }], 2, {
          ...(surfaceIds ? { id: "native-surface-copy" } : {}),
          __openclaw: { id: "reply" },
        }),
      ],
    });
    expect(groups).toHaveLength(expected.length);
    expected.forEach((text, index) => {
      expect(messageRecord(groupAt(groups, index)).content).toStrictEqual([{ type: "text", text }]);
    });
    if (surfaceIds) {
      expect(groupAt(groups, 0).senderLabel).toBeNull();
      expect(groupAt(groups, 0).messages).toHaveLength(1);
    }
  });

  it.each(["distinct imports", "incomplete imports", "canonical replay"])(
    "deduplicates user prompts only with proven identity: %s",
    (source) => {
      const canonical = {
        id: "canonical-replayed-user",
        idempotencyKey: "replayed-user-run:user",
        seq: 1,
      };
      const groups = messageGroups({
        messages: [1, 2].map((timestamp) =>
          userMessage([{ type: "text", text: "Same prompt" }], timestamp, {
            __openclaw:
              source === "canonical replay"
                ? { ...canonical }
                : {
                    id: "provider-local-user",
                    externalId: "provider-local-user",
                    importedFrom: "claude-cli",
                    ...(source === "distinct imports"
                      ? {
                          cliSessionId:
                            timestamp === 1 ? "first-cli-session" : "second-cli-session",
                          seq: timestamp,
                        }
                      : {}),
                  },
          }),
        ),
      });
      expect(groups).toHaveLength(1);
      const group = groupAt(groups, 0);
      expect(group.messages).toHaveLength(source === "canonical replay" ? 1 : 2);
      if (source === "distinct imports") {
        expect(messageRecord(group, 0)["__openclaw"]).toMatchObject({
          cliSessionId: "first-cli-session",
        });
        expect(messageRecord(group, 1)["__openclaw"]).toMatchObject({
          cliSessionId: "second-cli-session",
        });
      } else if (source === "incomplete imports") {
        expect(messageAt(group, 0).duplicateCount).toBeUndefined();
        expect(messageAt(group, 1).duplicateCount).toBeUndefined();
      } else {
        expect(group.role).toBe("user");
        expect(messageAt(group, 0).duplicateCount).toBe(2);
        expect(persistedMessageEntryId(messageRecord(group))).toBe(canonical.id);
      }
    },
  );

  it("suppresses assistant HEARTBEAT_OK acknowledgements before rendering history", () => {
    const groups = messageGroups({
      messages: [
        assistantMessage([{ type: "text", text: "HEARTBEAT_OK" }], 1),
        assistantMessage("HEARTBEAT_OK", 2),
        userMessage([{ type: "text", text: "HEARTBEAT_OK" }], 3),
        assistantMessage([{ type: "text", text: "Visible reply" }], 4),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groupAt(groups, 0).role).toBe("user");
    expect(groupAt(groups, 1).role).toBe("assistant");
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: "Visible reply" },
    ]);
  });

  it.each([
    {
      name: "suppresses active HEARTBEAT_OK streams before rendering",
      stream: "HEARTBEAT_OK",
    },
    {
      name: "suppresses active sender metadata streams before rendering",
      stream: SENDER_METADATA_BLOCK,
    },
  ])("$name", ({ stream }) => {
    const items = buildItems({
      stream,
      streamStartedAt: 1,
    });

    expect(items).toStrictEqual([]);
  });

  it.each([
    {
      name: "persisted prefix around an unkeyed preamble",
      liveOnly: false,
      props: {
        messages: [assistantMessage("First thought.", 1)],
        streamSegments: [
          { text: "First thought.", ts: 1, toolCallId: "call-1", persisted: true },
          { text: "Standalone preamble", ts: 2 },
          { text: "First thought. After tool.", ts: 3, toolCallId: "call-2" },
        ],
        toolMessages: [
          chatMessage("toolResult", "Tool one", 2),
          chatMessage("toolResult", "Tool two", 4),
        ],
        stream: "First thought. After tool. Continued.",
      },
      initialText: ["Standalone preamble", "After tool.", "Continued."],
      nextStream: "First thought. After tool. Continued. Again.",
      nextText: ["Standalone preamble", "After tool.", "Continued. Again."],
    },
    {
      name: "whole live reply after an accepted steer",
      liveOnly: true,
      props: {
        runId: "active-run",
        messages: [
          userMessage("Original prompt", 1, { __openclaw: { idempotencyKey: "active-run:user" } }),
          userMessage("Steer prompt", 4, {
            __openclaw: { idempotencyKey: "steer-run:user", steerTargetRunId: "active-run" },
          }),
        ],
        streamSegments: [
          { text: "Standalone preamble", ts: 3, runId: "active-run", itemId: "preamble" },
        ],
        stream: "Before steer. After steer.",
      },
      initialText: ["Before steer. After steer."],
      nextStream: "Before steer. After steer. Continued.",
      nextText: ["Before steer. After steer. Continued."],
    },
  ] satisfies {
    name: string;
    liveOnly: boolean;
    props: Partial<CachedChatItemsProps>;
    initialText: string[];
    nextStream: string;
    nextText: string[];
  }[])(
    "preserves cumulative stream text and cache identity with $name",
    ({ name, liveOnly, props, initialText, nextStream, nextText }) => {
      const input = createProps({ ...props, paneId: name, streamStartedAt: 5 });
      const streamTexts = (items: ReturnType<typeof buildCachedChatItems>) =>
        items.flatMap((item) =>
          item.kind === "stream" && (!liveOnly || item.isStreaming) ? [item.text] : [],
        );
      try {
        const initial = buildCachedChatItems(input);
        expect(streamTexts(initial)).toEqual(initialText);
        const next = { ...input, stream: nextStream };
        const cached = buildCachedChatItems(next);
        expect(cached).toBe(initial);
        expect(streamTexts(cached)).toEqual(nextText);
        expect(
          streamTexts(buildCachedChatItems({ ...next, messages: [...next.messages] })),
        ).toEqual(nextText);
      } finally {
        resetChatThreadState(name);
      }
    },
  );

  it("keeps same-millisecond segments interleaved with tools and mixed preambles", () => {
    const items = buildItems({
      streamSegments: [
        { text: "Setup", ts: 1_500 },
        { text: "Setup First tool.", ts: 2_000, toolCallId: "call-read" },
        { text: "Setup First tool. Second tool.", ts: 2_000, toolCallId: "call-list" },
        { text: "Unmatched preamble", ts: 2_000 },
        { text: "Keyed preamble", ts: 2_000, itemId: "keyed-preamble" },
      ],
      toolMessages: [
        toolResultMessage("call-read", "read", "file contents", 1_000),
        toolResultMessage("call-list", "list", "file list", 1_000),
      ],
    });

    expect(items).toHaveLength(7);
    expect(items[0]).toMatchObject({ kind: "stream", text: "Setup", startedAt: 1_500 });
    expect(items[1]).toMatchObject({ kind: "stream", text: "First tool." });
    expect(messageRecord(requireGroup(items[2])).toolCallId).toBe("call-read");
    expect(items[3]).toMatchObject({ kind: "stream", text: "Second tool." });
    expect(messageRecord(requireGroup(items[4])).toolCallId).toBe("call-list");
    expect(items.slice(5)).toEqual([
      expect.objectContaining({ kind: "stream", text: "Unmatched preamble" }),
      expect.objectContaining({ kind: "stream", text: "Keyed preamble" }),
    ]);
  });

  it("renders visible and attributed rows while filtering malformed or empty history", () => {
    const visible = assistantMessage("still visible", 1);
    const forwarded = assistantMessage([{ type: "text", text: "" }], 2, {
      senderLabel: "Forwarded from main",
    });
    const groups = messageGroups({
      messages: [null, {}, userMessage(SENDER_METADATA_BLOCK, 0), visible, forwarded],
    });
    expect(groups).toMatchObject([
      { role: "assistant", messages: [{ message: visible }] },
      { role: "assistant", senderLabel: "Forwarded from main", messages: [{ message: forwarded }] },
    ]);
  });

  it("does not expose malformed tool stream entries to message rendering", () => {
    const items = buildItems({
      toolMessages: [
        null,
        undefined,
        {
          role: "assistant",
          content: [{ type: "toolcall", name: "heartbeat_respond", arguments: {} }],
          timestamp: 1,
        },
      ],
    });

    const groups = items.filter((item) => item.kind === "group");
    expect(groups).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).role).toBe("assistant");
  });

  it("orders timestamped chat items before history messages without timestamps", () => {
    const items = buildItems({
      messages: [{ role: "assistant", content: "Missing timestamp." }],
      streamSegments: [{ text: "Timestamped stream.", ts: Number.MAX_SAFE_INTEGER }],
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "stream",
      text: "Timestamped stream.",
      startedAt: Number.MAX_SAFE_INTEGER,
      isStreaming: false,
    });
    expect(messageRecord(requireGroup(items[1])).content).toBe("Missing timestamp.");
  });

  it.each(["failed", "unconfirmed"] as const)(
    "keeps a %s attempted send after the preceding reply for inline retry",
    (sendState) => {
      const groups = messageGroups({
        messages: [assistantMessage("Previous reply", 2)],
        queue: [
          queuedSend("attempted-send-1", "retry me from the transcript", 1, sendState, {
            sendError: "Delivery diagnostic",
            sendAttempts: 1,
          }),
        ],
      });

      expect(groups.map((group) => group.role)).toEqual(["assistant", "user"]);
      const message = messageRecord(groupAt(groups, 1));
      expect(persistedMessageEntryId(message)).toBeNull();
      expect(message).toMatchObject({
        timestamp: 1,
        content: [{ type: "text", text: "retry me from the transcript" }],
      });
      expect(readPendingSendStatus(message)).toEqual({
        id: "attempted-send-1",
        state: sendState,
        error: "Delivery diagnostic",
      });
    },
  );

  it.each([
    {
      name: "nearest assistant turn",
      props: {
        messages: [
          chatMessage("assistant", undefined, 1_000, {
            id: "assistant-with-canvas",
            text: "First reply.",
          }),
          assistantMessage([{ type: "text", text: "Later unrelated reply." }], 2_000, {
            id: "assistant-without-canvas",
          }),
        ],
        toolMessages: [
          toolMessage(
            "call-canvas-old",
            "canvas_render",
            canvasToolOutput("cv_nearest_turn", "Nearest turn demo", 320),
            1_001,
            { id: "tool-canvas-for-first-reply" },
          ),
        ],
      },
      order: null,
      canvases: [
        [0, 1],
        [1, 0],
      ],
    },
    {
      name: "recovery turn after a system notice",
      props: {
        messages: [
          userMessage("Interrupted request", 1_000),
          assistantMessage("Interrupted reply", 2_000),
          userMessage("[System] Continue the interrupted turn.", 3_000, {
            provenance: { kind: "internal_system", sourceTool: "main_session_restart_recovery" },
          }),
        ],
        toolMessages: [mcpAppResult("mcp-app-recovery", "call-recovery", 3_001)],
        showToolCalls: false,
      },
      order: ["user", "assistant", "notice", "assistant"],
      canvases: [
        [1, 0],
        [2, 1],
      ],
    },
    {
      name: "silent turn before the next user prompt",
      props: {
        messages: [userMessage("Show the App", 1_000), userMessage("Next request", 2_000)],
        toolMessages: [mcpAppResult("mcp-app-earlier", "call-earlier", 1_001)],
        showToolCalls: false,
      },
      order: ["user", "assistant", "user"],
      canvases: [[1, 1]],
    },
    {
      name: "queued user prompt before its future follow-up",
      props: {
        messages: [userMessage("First request", 1_000), assistantMessage("First response", 1_001)],
        queue: [
          queuedSend("queued-app-turn", "Show the App", 2_000, "waiting-model", {
            sendSubmittedAtMs: 2_000,
          }),
          queuedSend("queued-future-turn", "Later request", 2_001, "waiting-reconnect", {
            sendSubmittedAtMs: 2_001,
            sendAttempts: 1,
          }),
        ],
        toolMessages: [mcpAppResult("mcp-app-queued", "call-queued", 2_002)],
        showToolCalls: false,
      },
      order: ["user", "assistant", "user", "assistant", "user"],
      canvases: [[3, 1]],
    },
  ] satisfies {
    name: string;
    props: Partial<CachedChatItemsProps>;
    order: string[] | null;
    canvases: [number, number][];
  }[])("places a lifted App preview in its $name", ({ props, order, canvases }) => {
    const items = buildItems(props);
    if (order) {
      expect(items.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual(order);
    }
    const groups = items.filter((item) => item.kind === "group");
    for (const [index, count] of canvases) {
      const blocks = canvasBlocksIn(groupAt(groups, index));
      if (count === 0) {
        expect(blocks).toStrictEqual([]);
      } else {
        expect(blocks).toHaveLength(count);
      }
    }
  });

  it("keeps a persisted App preview on an assistant search match", () => {
    for (const showToolCalls of [false, true]) {
      const groups = messageGroups({
        messages: [
          userMessage("Show the App", 1_000),
          mcpAppResult("mcp-app-persisted-search", "call-persisted-search", 1_001),
          assistantMessage("Matching preview", 1_002),
        ],
        toolMessages: [],
        searchOpen: true,
        searchQuery: "matching",
        showToolCalls,
      });

      const assistant = groups.find((group) => group.role === "assistant");
      expect(assistant).toBeDefined();
      expect(canvasBlocksIn(assistant as MessageGroup)).toHaveLength(1);
    }
  });

  it.each([
    {
      identity: "App id, retaining assistant-only views",
      count: 3,
      text: "Both Apps are ready.",
      results: [
        mcpAppResult("mcp-app-first", "call-first", 1_001),
        mcpAppResult("mcp-app-second", "call-second", 1_002),
      ],
      blocks: [
        mcpAppCanvasBlock("mcp-app-first", "call-first"),
        mcpAppCanvasBlock("mcp-app-second", "call-second"),
        mcpAppCanvasBlock("mcp-app-assistant-only", "call-assistant-only"),
      ],
    },
    {
      identity: "Canvas URL alone",
      count: 1,
      text: "The App is ready.",
      results: [
        toolResultMessage(
          "call-url-match",
          "show_widget",
          canvasToolOutput("cv_url_match", "URL match", 320),
          1_001,
        ),
      ],
      blocks: [
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            url: "/__openclaw__/canvas/documents/cv_url_match/index.html",
          },
        },
      ],
    },
  ])("deduplicates Gateway-embedded previews by $identity", ({ results, blocks, count, text }) => {
    const groups = messageGroups({
      messages: [
        userMessage("Show the Apps", 1_000),
        ...results,
        assistantMessage([{ type: "text", text }, ...blocks], 1_003),
      ],
      showToolCalls: false,
    });
    expect(groups.flatMap(canvasBlocksAcross)).toHaveLength(count);
    expect(groups.flatMap(normalizedBlocks)).toContainEqual({ type: "text", text });
  });

  it.each([
    { source: "live", kind: "mcp" },
    { source: "history-before", kind: "board" },
    { source: "history-after", kind: "mcp" },
  ])("preserves rich $kind metadata over a shortcode from $source", ({ source, kind }) => {
    const viewId = "cv_rich_shortcode";
    const callId = "call-rich-shortcode";
    const url = `/__openclaw__/canvas/documents/${viewId}/index.html`;
    const boardOutput = JSON.stringify({
      kind: "canvas",
      view: { id: viewId, url, title: "Widget", boardWidgetName: "saved-widget" },
      presentation: { target: "assistant_message", sandbox: "strict" },
    });
    const result =
      kind === "mcp"
        ? mcpAppResult(viewId, callId, 1_002)
        : toolResultMessage(callId, "show_widget", boardOutput, 1_002);
    const assistant = assistantMessage(
      [{ type: "text", text: `[embed ref="${viewId}" title="Widget" /]\n\nReady.` }],
      source === "history-after" ? 1_001 : 1_003,
    );
    const original = structuredClone(assistant);
    const history =
      source === "live"
        ? [assistant]
        : source === "history-before"
          ? [result, assistant]
          : [assistant, result];
    const groups = messageGroups({
      messages: [userMessage("Show a widget", 1_000), ...history],
      toolMessages:
        source !== "live"
          ? []
          : kind === "mcp"
            ? [mcpAppLiveResult(viewId, callId, 1_002)]
            : [toolMessage(callId, "show_widget", boardOutput, 1_002)],
      showToolCalls: false,
    });

    const previews = groups.flatMap(canvasBlocksAcross);
    expect(previews).toHaveLength(1);
    expect(previews[0]).toMatchObject({
      type: "canvas",
      preview:
        kind === "mcp"
          ? { viewId, sandbox: "scripts", mcpApp: mcpAppCanvasBlock(viewId, callId).preview.mcpApp }
          : { viewId, url, sandbox: "strict", boardWidgetName: "saved-widget" },
    });
    expect(groups.flatMap(normalizedBlocks)).toContainEqual({ type: "text", text: "\n\nReady." });
    expect(assistant).toEqual(original);
  });
  it("deduplicates untimestamped echoes without merging reused call IDs across turns", () => {
    const persisted = { ...mcpAppResult("first", "shared", 1_001), timestamp: undefined };
    const groups = messageGroups({
      messages: [userMessage("First App", 1_000), persisted, userMessage("Second App", 2_000)],
      toolMessages: [
        mcpAppLiveResult("first", "shared", 1_001),
        mcpAppLiveResult("second", "shared", undefined),
      ],
      showToolCalls: false,
    });
    expect(groups.map((group) => group.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(canvasBlocksIn(groupAt(groups, 1))).toHaveLength(1);
    expect(canvasBlocksIn(groupAt(groups, 3))).toHaveLength(1);
  });
});

describe("tool expansion state", () => {
  it("skips the tool-card walk when the item array identity is unchanged", () => {
    resetChatThreadState();
    const group = preparedGroup("assistant-stable", {
      role: "assistant",
      content: "No tools in this row",
    });
    const items = [group];
    const extractSpy = vi.spyOn(toolCards, "extractToolCardsCached");
    try {
      syncToolCardExpansionState("identity-stable", items, false);
      const callsAfterFirstSync = extractSpy.mock.calls.length;

      syncToolCardExpansionState("identity-stable", items, false);

      expect(callsAfterFirstSync).toBeGreaterThan(0);
      expect(extractSpy).toHaveBeenCalledTimes(callsAfterFirstSync);
    } finally {
      extractSpy.mockRestore();
    }
  });

  it("auto-expands top-level tool-name result disclosures", () => {
    resetChatThreadState();
    const group = preparedGroup("tool-name-result", {
      role: "assistant",
      toolName: "bash",
      content: "Tool output",
    });

    syncToolCardExpansionState("tool-name-session", [group], true);

    expect(getExpandedToolCards("tool-name-session").get("toolmsg:tool-name-result")).toBe(true);
  });
});

describe("expansion-state render dependencies", () => {
  it("reads unchanged tool and user expansion maps without locale sorting", () => {
    resetChatThreadState();
    const tools = getExpandedToolCards("fast-session");
    const users = getExpandedUserMessages("fast-session");
    for (let index = 0; index < 128; index += 1) {
      setExpansionState(tools, `tool-${127 - index}`, index % 2 === 0);
      setExpansionState(users, `user-${127 - index}`, index % 2 === 0);
    }
    const compare = vi.spyOn(String.prototype, "localeCompare");
    try {
      expect(getExpansionStateVersion(tools)).toBe(tools.size);
      expect(getExpansionStateVersion(users)).toBe(users.size);
      expect(compare.mock.calls.length).toBe(0);
    } finally {
      compare.mockRestore();
    }
  });

  it("shares user-message render versions across equivalent session aliases", () => {
    resetChatThreadState();
    setExpansionState(getExpandedUserMessages("main"), "user-message", true);

    expect(getExpansionStateVersion(getExpandedUserMessages("main"))).toBe(1);
    expect(getExpansionStateVersion(getExpandedUserMessages("agent:main:main"))).toBe(1);

    setExpansionState(getExpandedUserMessages("agent:main:main"), "user-message", false);
    expect(getExpansionStateVersion(getExpandedUserMessages("main"))).toBe(2);
    expect(getExpandedUserMessages("main").get("user-message")).toBe(false);
  });

  it("prunes cards removed during search when the same visible projection becomes complete", () => {
    resetChatThreadState();
    const sessionKey = "search-removes-hidden-card";
    const group = (key: string) =>
      preparedGroup(key, {
        role: "assistant",
        content: [{ type: "toolcall", id: `call-${key}`, name: "browser.open" }],
      });
    const hidden = group("hidden-card");
    const visible = group("visible-card");
    const visibleProjection = [visible];
    syncToolCardExpansionState(sessionKey, [hidden, visible], false);
    const expanded = getExpandedToolCards(sessionKey);
    const hiddenCardId = "hidden-card:toolcard:0";
    setExpansionState(expanded, hiddenCardId, true);

    syncToolCardExpansionState(sessionKey, visibleProjection, false, true);
    expect(expanded.get(hiddenCardId)).toBe(true);
    const filteredVersion = getExpansionStateVersion(expanded);

    syncToolCardExpansionState(sessionKey, visibleProjection, false);

    expect(expanded.has(hiddenCardId)).toBe(false);
    expect(expanded.has("visible-card:toolcard:0")).toBe(true);
    expect(getExpansionStateVersion(expanded)).toBe(filteredVersion + 1);
  });

  it("auto-expands retained cards hidden while transcript search is active", () => {
    resetChatThreadState();
    const sessionKey = "search-auto-expands-hidden-cards";
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hidden assistant reply" },
          { type: "toolcall", id: "hidden-call", name: "browser.open" },
        ],
      },
      { role: "user", content: "another turn" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "needle visible reply" },
          { type: "toolcall", id: "visible-call", name: "browser.open" },
        ],
      },
    ];
    const complete = buildItems({ sessionKey, messages });
    syncToolCardExpansionState(sessionKey, complete, false);
    const expanded = getExpandedToolCards(sessionKey);
    const cardIds = [...expanded.keys()];
    const hiddenCardId = expectDefined(cardIds[0], "hidden retained card");
    const visibleCardId = expectDefined(cardIds[1], "visible retained card");

    const filtered = buildItems({ sessionKey, messages, searchOpen: true, searchQuery: "needle" });
    syncToolCardExpansionState(sessionKey, filtered, false, true);
    expect(expanded.get(hiddenCardId)).toBe(false);
    expect(expanded.get(visibleCardId)).toBe(false);

    syncToolCardExpansionState(sessionKey, filtered, true, true);

    expect(expanded.get(hiddenCardId)).toBe(true);
    expect(expanded.get(visibleCardId)).toBe(true);
    syncToolCardExpansionState(sessionKey, buildItems({ sessionKey, messages }), true);
    expect(expanded.get(hiddenCardId)).toBe(true);
    expect(expanded.get(visibleCardId)).toBe(true);
  });

  it("drops render versions with evicted and reset session maps", () => {
    resetChatThreadState();
    const items = buildItems({
      sessionKey: "evicted-session",
      messages: [toolUseMessage("evicted-call", "read", {}, 1)],
    });
    syncToolCardExpansionState("evicted-session", items, true);
    const evicted = getExpandedToolCards("evicted-session");
    expect([...evicted.values()]).toEqual([true]);
    for (let index = 0; index < 20; index += 1) {
      getExpandedToolCards(`other-session-${index}`);
    }

    expect(getExpandedToolCards("evicted-session")).not.toBe(evicted);
    expect(getExpansionStateVersion(getExpandedToolCards("evicted-session"))).toBe(0);
    syncToolCardExpansionState("evicted-session", items, true);
    expect([...getExpandedToolCards("evicted-session").values()]).toEqual([true]);

    setExpansionState(getExpandedUserMessages("reset-session"), "message", true);
    resetChatThreadState();
    expect(getExpansionStateVersion(getExpandedUserMessages("reset-session"))).toBe(0);
  });
});

describe("thread item cache", () => {
  it("repositions an initial placement prompt when recovery identifies its existing queue row", () => {
    const queued = queuedSend("initial", "Original request", 10_000, "failed", {
      sendRunId: "initial",
      sendAttempts: 1,
    });
    const input = createProps({
      messages: [assistantMessage("Gateway recovery", 2)],
      queue: [queued],
    });
    const roles = (items: ReturnType<typeof buildCachedChatItems>) =>
      items.filter((item) => item.kind === "group").map((item) => item.role);

    expect(roles(buildCachedChatItems(input))).toEqual(["assistant", "user"]);
    expect(roles(buildCachedChatItems({ ...input, initialTurnId: queued.id }))).toEqual([
      "user",
      "assistant",
    ]);
    expect(roles(buildCachedChatItems(input))).toEqual(["assistant", "user"]);
  });

  it("updates the live stream without rescanning retained history", () => {
    resetChatThreadState();
    const reads = { count: 0 };
    const messages = Array.from(
      { length: 1_000 },
      (_, index) =>
        new Proxy(
          {
            role: index % 2 === 0 ? "user" : "assistant",
            content: `message ${index}`,
            timestamp: index,
          },
          {
            get(target, property, receiver) {
              reads.count += 1;
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    );
    const input = createProps({
      messages,
      stream: "partial reply",
      streamStartedAt: 10,
    });
    const first = buildCachedChatItems(input);
    reads.count = 0;

    const updated = buildCachedChatItems({ ...input, stream: "complete reply" });

    expect(updated).toBe(first);
    expect(reads.count).toBe(0);
    expect(updated).toContainEqual(
      expect.objectContaining({ kind: "stream", text: "complete reply", isStreaming: true }),
    );
  });

  it("keeps same-session render caches isolated between panes", () => {
    resetChatThreadState();
    const messages = [
      { role: "assistant", content: "needle" },
      { role: "user", content: "other" },
    ];
    const paneA = createProps({
      paneId: "pane-a",
      messages,
      searchOpen: true,
      searchQuery: "needle",
    });
    const paneB = createProps({ paneId: "pane-b", messages });

    const paneAItems = buildCachedChatItems(paneA);
    const paneBItems = buildCachedChatItems(paneB);

    expect(buildCachedChatItems({ ...paneA })).toBe(paneAItems);
    expect(buildCachedChatItems({ ...paneB })).toBe(paneBItems);

    resetChatThreadState("pane-a");
    expect(buildCachedChatItems({ ...paneA })).not.toBe(paneAItems);
    expect(buildCachedChatItems({ ...paneB })).toBe(paneBItems);
  });
});

function canvasBlocksIn(group: MessageGroup): unknown[] {
  return firstMessageContent(group).filter((block) => isCanvasBlock(block));
}

function normalizedBlocks(group: MessageGroup) {
  return group.messages.flatMap(({ message }) => normalizeMessage(message).content);
}

function canvasBlocksAcross(group: MessageGroup): unknown[] {
  return normalizedBlocks(group).filter(isCanvasBlock);
}

function isCanvasBlock(block: unknown): boolean {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    (block as { type?: unknown; preview?: { kind?: unknown } }).type === "canvas" &&
    (block as { preview?: { kind?: unknown } }).preview?.kind === "canvas"
  );
}

function mcpAppDescriptor(viewId: string, toolCallId: string) {
  return {
    viewId,
    serverName: "demo",
    toolName: "show",
    uiResourceUri: "ui://demo/app.html",
    toolCallId,
  };
}

function mcpAppCanvasBlock(viewId: string, toolCallId: string) {
  return {
    type: "canvas",
    preview: {
      kind: "canvas",
      surface: "assistant_message",
      render: "url",
      viewId,
      title: "Demo App",
      url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
      sandbox: "scripts",
      mcpApp: mcpAppDescriptor(viewId, toolCallId),
    },
  };
}

function mcpAppResult(viewId: string, toolCallId: string, timestamp: number) {
  return toolResultMessage(toolCallId, "demo__show", [{ type: "text", text: "ok" }], timestamp, {
    details: {
      mcpAppPreview: {
        kind: "canvas",
        view: { id: viewId, title: "Demo App" },
        presentation: { target: "assistant_message", sandbox: "scripts" },
        mcpApp: mcpAppDescriptor(viewId, toolCallId),
      },
    },
  });
}

function mcpAppLiveResult(viewId: string, toolCallId: string, timestamp: number | undefined) {
  const persisted = mcpAppResult(viewId, toolCallId, timestamp ?? 0);
  return assistantMessage(
    [
      { type: "toolcall", name: "demo__show", arguments: {} },
      {
        type: "toolresult",
        name: "demo__show",
        text: "ok",
        details: persisted.details,
      },
    ],
    timestamp,
    {
      toolCallId,
      runId: "run-live",
      __openclawToolStreamLive: true,
      __openclawToolStreamResultReceived: true,
    },
  );
}

const nestedUser = {
  role: "user",
  content: "Run the task",
  timestamp: 1,
  __openclaw: { id: "user", seq: 1, transcriptPosition: { source: "snapshot", rawSeq: 0 } },
};

function completedCall(
  id: string,
  name: string,
  rawSeq: number,
  activity?: { afterRawSeq: number; startOrder: number },
) {
  return {
    role: "assistant",
    runId: "run",
    timestamp: 1,
    content: [
      { type: "toolCall", id, name, arguments: {} },
      { type: "toolResult", toolCallId: id, name, content: [{ type: "text", text: "done" }] },
    ],
    __openclaw: {
      id,
      seq: rawSeq + 1,
      transcriptPosition: {
        source: "snapshot",
        rawSeq,
        ...(activity ? { activity: { ...activity, scopeId: "attempt" } } : {}),
      },
    },
  };
}

function renderedToolIds(messages: unknown[], toolMessages: unknown[] = []) {
  const items = buildChatItems(
    createProps({
      paneId: "nested-activity",
      sessionKey: "agent:main:main",
      runId: "run",
      messages,
      toolMessages,
    }),
  );
  return items.flatMap((item) =>
    item.kind === "group"
      ? item.messages.flatMap(({ message }) => extractToolCards(message).map((card) => card.id))
      : [],
  );
}

describe("durable nested activity composition", () => {
  it("keeps durable bundled calls after exec across an early live echo and stream", () => {
    const ids = ["first", "second"];

    const exec = completedCall("exec", "exec", 1);
    const wait = completedCall("wait", "wait", 4);
    const children = ids.map((id, startOrder) =>
      completedCall(id, "read", 5, { afterRawSeq: 1, startOrder }),
    );
    for (const child of children) {
      for (const block of child.content) {
        Object.assign(block, { parentToolCallId: "exec" });
      }
    }
    const durable = {
      ...children[0],
      content: children.flatMap((child) => child.content),
    };
    const history = [nestedUser, exec, wait, durable];
    const original = structuredClone(history);
    const items = buildChatItems(
      createProps({
        paneId: "nested-activity-stream",
        sessionKey: "agent:main:main",
        runId: "run",
        messages: history,
        toolMessages: children.map((child) => ({
          role: child.role,
          runId: child.runId,
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: false,
          timestamp: 0,
          content: structuredClone(child.content.filter((block) => block.type === "toolCall")),
        })),
        streamSegments: [{ text: "Still working", ts: 0.5, runId: "run" }],
      }),
    );
    const visibleOrder = items.flatMap((item) => {
      if (item.kind !== "group") {
        return [item.kind];
      }
      return item.messages.flatMap(({ message }) => {
        const cards = extractToolCards(message);
        return cards.length > 0 ? cards.map((card) => card.id) : [item.role];
      });
    });
    expect(visibleOrder).toEqual(["user", "stream", "exec", ...ids, "wait"]);
    const rendered = items.flatMap((item) =>
      item.kind === "group" ? item.messages.map(({ message }) => message) : [],
    );
    expect(
      rendered
        .flatMap((message) => extractToolCards(message))
        .filter((card) => ids.includes(card.callId ?? "")),
    ).toEqual(
      ids.map((id) =>
        expect.objectContaining({
          callId: id,
          runId: "run",
          parentToolCallId: "exec",
          completed: true,
          outputText: "done",
        }),
      ),
    );
    expect(history).toEqual(original);
  });

  it.each([
    {
      name: "malformed activity retains earliest live echo",
      malformed: true,
      order: ["first", "exec", "wait"],
    },
    {
      name: "completed anchor uses its physical position",
      malformed: false,
      order: ["exec", "earlier", "wait", "later"],
    },
  ])("places nested activity when $name", ({ malformed, order }) => {
    const first = completedCall(malformed ? "first" : "earlier", "read", 5, {
      afterRawSeq: malformed ? 5 : 1,
      startOrder: 0,
    });
    const messages = [
      nestedUser,
      completedCall("exec", "exec", 1),
      completedCall("wait", "wait", 4),
      first,
      ...(malformed ? [] : [completedCall("later", "read", 6, { afterRawSeq: 5, startOrder: 1 })]),
    ];
    const live = malformed
      ? [
          {
            ...first,
            __openclaw: undefined,
            __openclawToolStreamLive: true,
            __openclawToolStreamResultReceived: true,
            timestamp: 0,
          },
        ]
      : [];
    expect(renderedToolIds(messages, live)).toEqual(order);
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
