// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { prependUniqueNativeMessages } from "../../lib/chat/history-message-identity.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import * as toolCards from "../../lib/chat/tool-cards.ts";
import { resolveWorkingProgress } from "./chat-progress.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import {
  groupsOf as groupsIn,
  message as chatMessage,
  messagesOf as messagesIn,
  nativeMessage,
  pending as pendingInput,
  person as senderProfile,
  queued as queuedSend,
  signedText,
  text as textBlock,
  toolResult as resultMessage,
} from "./chat-thread-fixtures.test-support.ts";
import { groupMessages } from "./chat-thread-grouping.ts";
import * as threadItems from "./chat-thread-items.ts";
import { persistedMessageEntryId, readPendingSendStatus } from "./chat-thread-items.ts";
import { buildItems, createProps, type CachedChatItemsProps } from "./chat-thread.test-support.ts";
import {
  buildCachedChatItems,
  getExpansionStateVersion,
  getExpandedToolCards,
  getExpandedUserMessages,
  resetChatThreadState,
  setExpansionState,
  subscribeExpansionState,
  syncToolCardExpansionState,
} from "./chat-thread.ts";
import { coalesceStreamRuns, collapseCompletedTurnWork } from "./chat-turn-presentation.ts";
import { publishChatSessionProjectionMessages } from "./history-merge.ts";
import { createSnapshotRecord } from "./session-snapshot-record.ts";
import {
  normalizeFinalAssistantMessage,
  readLiveTerminalRevision,
  rememberLiveTerminalRun,
} from "./terminal-message-identity.ts";

const { extractToolCardsCached: extractToolCards } = toolCards;

beforeEach(() => resetChatThreadState());
afterEach(() => vi.restoreAllMocks());

it("projects an older page without retiring the live progress clock", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  const props = createProps({ messages: [{ role: "user", content: "Earlier prompt" }] });
  const before = resolveWorkingProgress(props.sessionKey, null, null, [], [], []);
  now.mockReturnValue(10000);
  expect(buildChatItems(props, undefined, "history")).toMatchObject([
    { kind: "group", role: "user" },
  ]);
  const after = resolveWorkingProgress(props.sessionKey, null, null, [], [], []);
  expect(after.key).toBe(before.key);
  expect(after.startedAt).toBe(1000);
});

function preparedGroup(key: string, message: unknown): MessageGroup {
  return requireGroup(groupMessages([{ kind: "message", key, message }])[0]);
}

// Display fixtures need provenance markers for inbound-metadata stripping.
const SENDER_METADATA_BLOCK = `${markInboundContextLabel("Sender:")}\n\`\`\`json\n{"label":"openclaw-control-ui","id":"openclaw-control-ui"}\n\`\`\``;

const user = chatMessage.bind(null, "user");
const assistant = chatMessage.bind(null, "assistant");
const toolCall = (id: string | undefined, name = "exec", args: unknown = {}) => ({
  type: "toolcall",
  ...(id === undefined ? {} : { id }),
  name,
  arguments: args,
});

function nativeUser(sendId: string, text: unknown, timestamp: number, metadata: object = {}) {
  return nativeMessage("user", text, timestamp, { idempotencyKey: `${sendId}:user`, ...metadata });
}

function toolUseMessage(
  id: string,
  name: string,
  input: unknown,
  timestamp: number,
): Record<string, unknown> {
  return assistant([{ type: "tool_use", id, name, input }], timestamp);
}

function toolMessage(...args: Parameters<typeof resultMessage>): Record<string, unknown> {
  return { ...resultMessage(...args), role: "tool" };
}

it("invalidates cached custody notices when workspace sync ownership changes", () => {
  const pendingInputs = [
    pendingInput("pending-follow-up", "follow-up-run", user("continue", 1), 1),
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

function canvasBlock<P extends object>(preview: P) {
  return {
    type: "canvas",
    preview: { kind: "canvas", surface: "assistant_message", render: "url", ...preview },
  };
}

function messageGroups(props: Partial<CachedChatItemsProps>): MessageGroup[] {
  return buildCachedChatItems(createProps(props)).filter((item) => item.kind === "group");
}

function cardsIn(groups: readonly MessageGroup[]) {
  return messagesIn(groups).flatMap((message) => extractToolCards(message));
}

function requireItem<T extends { kind: string }, K extends T["kind"]>(
  items: readonly T[],
  kind: K,
) {
  return expectDefined(
    items.find((item): item is Extract<T, { kind: K }> => item.kind === kind),
    kind,
  );
}

function expectKinds(items: readonly { kind: string }[], kinds: string[]) {
  expect(items.map((item) => item.kind)).toEqual(kinds);
}

function expectRoles(items: ReturnType<typeof buildItems>, roles: string[]) {
  expect(items.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual(roles);
}

function firstMessageContent(group: MessageGroup): unknown[] {
  const content = messageRecord(group).content;
  return Array.isArray(content) ? content : [];
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");
type ThreadItem = ReturnType<typeof collapseCompletedTurnWork>[number];

function requireGroup(value: ThreadItem | undefined): MessageGroup {
  return expectDefined(value?.kind === "group" ? value : undefined, "message group");
}

function groupAt(groups: readonly MessageGroup[], index: number): MessageGroup {
  return expectDefined(groups[index], `message group ${index}`);
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
        nativeUser("original-submit", "Original", 1, { runId: "active-run" }),
        nativeUser("steer-run", "Steer", 2, { steerTargetRunId: "active-run" }),
      ],
      streamSegments: [{ text: "After steer", ts: 3, runId: "active-run", toolCallId }],
      toolMessages: [
        resultMessage(toolCallId, "shell", "Tool after steer", 4, {
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

  it("unmatched legacy replay retains timestamp placement across older turns", () => {
    const items = buildItems({
      runId: "run-current",
      messages: [
        user("First prompt", 1_000),
        assistant("First reply", 1_300),
        user("Second prompt", 2_000),
        assistant("Second reply", 2_300),
        user("Current prompt", 3_000),
      ],
      toolMessages: [
        resultMessage("call-legacy", "shell", "Legacy tool output", 1_100, {
          runId: "legacy-unmatched-run",
        }),
      ],
    });
    expectRoles(items, ["user", "tool", "assistant", "user", "assistant", "user"]);
  });

  it.each([
    { source: "live terminal", search: false },
    { source: "durable reply", search: true },
  ] as const)(
    "keeps a sending prompt before its $source under clock skew with search=$search",
    ({ source, search }) => {
      const paneId = `reply-before-user:${source}:sending:${search}:true`;
      const terminal =
        source === "live terminal"
          ? rememberLiveTerminalRun(assistant("Current reply", 1_000), "run-active")
          : assistant("Current reply", 1_000, {
              __openclaw: { id: "durable-reply", seq: 6, runId: "run-active" },
            });
      const preceding = [
        user("Earlier prompt", 500),
        assistant("Unowned reply", 4_000),
        assistant("Unrelated reply", 300, { __openclaw: { runId: "other-run" } }),
        assistant("Imported reply", 2_500, {
          __openclaw: {
            importedFrom: "claude-cli",
            cliSessionId: "external-session",
            externalId: "external-reply",
            runId: "run-active",
          },
        }),
        assistant("Unattributed run hint", 900, { runId: "run-active" }),
      ];
      if (search) {
        preceding.push(
          assistant("Hidden earlier output", 950, {
            __openclaw: { id: "hidden-output", seq: 5, runId: "run-active" },
          }),
        );
      }
      const sending = queuedSend("sending-current", "Current prompt", 2_000, "sending", {
        sendAttempts: 1,
        sendRunId: "run-active",
      });
      const liveItems = buildItems({
        paneId,
        runId: "run-active",
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
          nativeUser("run-active", [textBlock("Current prompt")], 2_000),
          terminal,
        ],
      });
      resetChatThreadState(paneId);
      const expected = [
        ...(search ? [] : preceding),
        expect.objectContaining({
          role: "user",
          content: [textBlock("Current prompt")],
        }),
        terminal,
      ];
      expect(messagesIn(groupsIn(liveItems))).toEqual(expected);
      expect(messagesIn(groupsIn(stableItems))).toEqual(expected);
    },
  );

  it("hides durable commentary when the display preference is disabled", () => {
    const paneId = "commentary-visibility";
    const messages = [
      user("do it", 1_000),
      assistant("Checking the workspace.", 2_000, {
        openclawStreamFallback: {
          replacementText: "Checking the workspace.",
          source: "segment",
          itemId: "preamble-1",
        },
      }),
      assistant("All done.", 3_000),
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

  function requireWorkGroup(value: ThreadItem | undefined) {
    return expectDefined(value?.kind === "work-group" ? value : undefined, "work group");
  }

  const toolResult = (id: string, timestamp: number, isError = false) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    isError,
    content: isError ? "boom" : "ok",
    timestamp,
  });

  it.each(["context event", "persisted boundary"])("renders a compaction %s", (source) => {
    const boundary = source === "persisted boundary";
    const marker = boundary
      ? {
          role: "system",
          timestamp: 2_000,
          __openclaw: {
            kind: "compaction",
            id: "checkpoint-with-metrics",
            tokensBefore: 900_000,
            tokensAfter: 24_700,
          },
        }
      : chatMessage("custom", "Context compacted", 2_000, {
          customType: "openclaw.context-compaction",
          display: true,
          excludeFromContext: true,
          details: { runId: "run-1" },
          idempotencyKey: "codex-context-compaction:thread:turn:item",
        });
    const items = collapsedItems({
      messages: boundary ? [marker] : [user("do it", 1_000), marker, assistant("All done.", 3_000)],
    });
    expect(items[boundary ? 0 : 1]).toMatchObject(
      boundary
        ? { kind: "divider", label: "Context compacted", metric: "saved 875.3k tokens" }
        : { compaction: "complete", label: "Context compacted" },
    );
    if (!boundary) {
      expectKinds(items, ["group", "divider", "group"]);
      expect(requireGroup(items[2]).messages[0]?.message).toMatchObject({ content: "All done." });
    }
  });

  it("keeps a tool visualization visible while collapsing its work", () => {
    const items = collapsedItems({
      messages: [
        user("show the result", 1_000),
        resultMessage(
          "visualization",
          "show_widget",
          [mcpAppCanvasBlock("completed-turn", "visualization")],
          2_000,
        ),
        assistant("Checking the details.", 2_500),
        toolResult("call-1", 3_000),
        assistant("All done.", 4_000),
      ],
    });
    expectKinds(items, ["group", "work-group", "group", "group"]);
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
          user("do it", 1_000),
          assistant("Checking…", 2_000),
          toolResult("call-1", 3_000),
          assistant("All done.", 10_000),
        ],
      }),
    );

    const rendered = collapseCompletedTurnWork(items, { sessionKey, runWorking: false });

    expectKinds(rendered, ["group", "group", "group", "group"]);
  });

  it("does not borrow an unscoped answer across a queued message from a peer", () => {
    const messages = [
      nativeUser("active-run", "do it", 1_000, { senderId: "operator" }),
      assistant("Checking…", 2_000),
      toolResult("call-1", 3_000),
      nativeUser("queued-run", "queued follow-up", 3_500, { senderId: "peer" }),
      nativeUser("steer-run", "continue", 4_000, {
        senderId: "operator",
        steerTargetRunId: "active-run",
      }),
      assistant("All done.", 5_000),
    ];

    expect(
      collapsedItems({ messages, runWorking: true }, true).some(
        (item) => item.kind === "work-group",
      ),
    ).toBe(false);

    const completed = collapsedItems({ messages });
    expectKinds(completed, ["group", "work-group", "group", "group", "group", "group"]);
    expect(messagesIn(requireWorkGroup(completed[1]).groups)).toEqual([messages[2]]);
    expect(messagesIn(groupsIn(completed))).toEqual(messages.filter((_, index) => index !== 2));
  });

  it.each([
    {
      name: "structured error",
      result: { content: [{ type: "tool_result", isError: true, text: "boom" }] },
    },
    {
      name: "inferred error",
      result: { content: '{"status":"error","error":"boom"}' },
    },
  ])("keeps trailing failed work outside the disclosure ($name)", ({ result }) => {
    const trailing = { ...toolResult("call-2", 4_000), isError: undefined, ...result };
    const items = collapsedItems({
      messages: [
        user("go", 1_000),
        toolResult("call-1", 2_000),
        assistant("Done.", 3_000),
        trailing,
      ],
    });

    expectKinds(items, ["group", "work-group", "group", "group"]);
    const work = requireWorkGroup(items[1]);
    expect(work.groups).toHaveLength(1);
    expect(requireGroup(items[3]).messages.map(({ message }) => message)).toContain(trailing);
  });

  it("collapses a trailing failure only after a subsequent answer", () => {
    const failed = toolResult("failed", 4_000, true);
    const messages = [
      user("go", 1_000),
      assistant("First result.", 2_000),
      failed,
      assistant([signedText("Checking the failure.", "commentary", "checking")], 5_000),
      toolResult("supplementary", 6_000),
    ];
    const idle = collapsedItems({ messages });
    expect(messagesIn(groupsIn(idle))).toContain(failed);
    const recovered = collapsedItems({
      messages: [...messages, assistant("Recovered via another route.", 7_000)],
    });
    expect(messagesIn(groupsIn(recovered))).not.toContain(failed);
    expect(messagesIn(requireWorkGroup(recovered[1]).groups)).toContain(failed);
  });
});

describe("buildCachedChatItems row identity", () => {
  it("preserves a same-role group key as messages are prepended and appended", () => {
    const reply = (text: string, seq: number) =>
      assistant(text, seq, { __openclaw: { id: `assistant-${seq - 1}`, seq } });
    const firstGroup = (messages: unknown[]) => groupAt(messageGroups({ messages }), 0);
    const first = reply("First", 2);
    const second = reply("Second", 3);
    const initial = firstGroup([first, second]);
    const prepended = firstGroup([reply("Earlier", 1), first, second]);
    const appended = firstGroup([...messagesIn([prepended]), reply("Later", 4)]);

    expect(prepended.key).toBe(initial.key);
    expect(appended.key).toBe(initial.key);
  });

  it("does not reclaim a group key naturally owned by another reordered group", () => {
    const first = user("First", 1, {
      __openclaw: { id: "first", seq: 1 },
      senderLabel: "same",
    });
    const second = user("Second", 2, {
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
    const sessionKey = "agent:main:working-row";
    const failed = queuedSend("failed", "Earlier failure", 0, "failed", {
      sendRunId: "failed-run",
      sendAttempts: 1,
      sendError: "Rejected",
    });
    const project = (props: Partial<CachedChatItemsProps>) => {
      const items = buildItems({ sessionKey, runWorking: true, queue: [failed], ...props });
      return { items, indicator: requireItem(items, "reading-indicator") };
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
    const stream = requireItem(
      streaming.items.filter((item) => item.kind === "stream" && item.isStreaming),
      "stream",
    );
    expect([stream.key, streaming.indicator.key]).toEqual([
      pending.indicator.key,
      pending.indicator.key,
    ]);
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

  it("times an externally admitted run from its own start, not the previous run's activity", () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const sessionKey = "agent:main:external-runs";
    const firstTool = resultMessage("first-call", "read", "first", 1_100, {
      runId: "first-run",
      __openclawToolStreamReceivedAt: 1_100,
    });
    const indicatorFor = (props: Partial<CachedChatItemsProps>) =>
      requireItem(
        buildItems({ sessionKey, toolMessages: [firstTool], ...props }),
        "reading-indicator",
      );
    vi.setSystemTime(1_000);
    expect(
      indicatorFor({
        runWorking: true,
        runActive: true,
        runId: "first-run",
        stream: "",
        streamStartedAt: 1_000,
      }),
    ).toMatchObject({ runId: "first-run", startedAt: 1_000 });
    vi.setSystemTime(30_000);
    expect(readingIndicator({ sessionKey, toolMessages: [firstTool] })).toBeUndefined();

    vi.setSystemTime(60_000);
    const admitted = indicatorFor({ runWorking: true, runActive: true });
    expect(admitted.startedAt).toBe(60_000);
    expect(admitted.runId).toBeUndefined();
    vi.setSystemTime(60_500);
    expect(
      indicatorFor({
        runWorking: true,
        runActive: true,
        runId: "second-run",
        stream: "",
        streamStartedAt: 60_500,
      }),
    ).toMatchObject({ key: admitted.key, runId: "second-run", startedAt: 60_000 });
  });

  it("yields to the initial-load skeleton on an empty thread", () => {
    expect(readingIndicator({ runWorking: true, loading: true })).toBeUndefined();
  });
});

describe("buildCachedChatItems", () => {
  it("reuses absent canvas previews through older-page merges and invalidates replacements", () => {
    const output = JSON.stringify({ exitCode: 0, output: "current" });
    const current = resultMessage("current-call", "custom", output, 2, {
      __openclaw: { id: "current" },
    });
    const olderOutput = JSON.stringify({ exitCode: 0, output: "older" });
    const older = resultMessage("older-call", "custom", olderOutput, 1, {
      __openclaw: { id: "older" },
    });
    const owner = { sessionKey: "preview-pages", chatMessages: [current] as unknown[] };
    const prepare = vi.spyOn(toolCards, "extractToolPreview");
    const rebuild = () =>
      buildItems({ paneId: "preview-pages", messages: [...owner.chatMessages] });
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
  });

  it("does not inspect ordinary transcript messages for tool previews", () => {
    const messages = [user("hello", 1_000), assistant("reply", 1_001)];
    const previewExtraction = vi.spyOn(threadItems, "extractChatMessagePreview");
    buildItems({ paneId: "ordinary-transcript", messages });
    expect(previewExtraction).not.toHaveBeenCalled();
  });

  it("sender provenance separates namespaces without splitting profile renames", () => {
    const groups = messageGroups({
      messages: [
        user("first", 1000, {
          __openclaw: {
            ...senderProfile("shared", "Same"),
          },
        }),
        user("second", 1001, {
          __openclaw: {
            ...senderProfile("shared", "Renamed"),
            senderProfileAvatarUrl: "/api/users/shared/avatar?v=2",
          },
        }),
        user("third", 1002, {
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
      textBlock("Keep this explanation"),
      { type: "tool_result", tool_use_id: "call-a", content: "contents of a" },
      { type: "tool_result", tool_use_id: "call-b", content: "contents of b" },
    ];
    const groups = messageGroups({
      messages: [
        user(mixedContent, 1000),
        assistant(
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
      assistant([{ type: "toolCall", id, name, arguments: { command: "echo ready" } }], 10, {
        runId,
      });
    const result = (id: string, text = "ready", runId: string | undefined = "run-a") =>
      resultMessage(id, "exec", [textBlock(text)], 20, { runId });
    const snapshot = (id: string, completed = true) =>
      assistant(
        [
          toolCall(undefined, "exec", { command: "echo ready" }),
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
      cardsIn(messageGroups({ messages, toolMessages }));

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

    it.each(["reset", "reused"])(
      "does not relocate a live invocation across a boundary with %s ownership",
      (ownership) => {
        const persisted = call("exec-1");
        const live = snapshot("exec-1", false);
        const groups = messageGroups({
          runId: "run-a",
          messages: [
            user("Original request", 1),
            persisted,
            ...(ownership === "reset" ? [resetMessage("reset-invocation")] : []),
            user("Next request", 15),
            ...(ownership === "reused" ? [call("exec-1")] : []),
          ],
          toolMessages: [live],
        });
        const cards = cardsIn(groups);
        expect(cards).toHaveLength(2);
        expect(cards.filter((card) => card.outputText === "working")).toHaveLength(1);
      },
    );

    it("reconciles a multi-call snapshot without losing surrounding content or result metadata", () => {
      const attachment = { type: "image", data: "fixture-image", mimeType: "image/png" };
      const history = assistant(
        [
          textBlock("Before calls"),
          toolCall("a", "exec", { command: "first" }),
          toolCall("b", "exec", { command: "second" }),
          textBlock("After calls"),
        ],
        10,
        { runId: "run-a", __openclaw: { id: "transcript-call" } },
      );
      const terminal = result("a", "failed");
      terminal.content = [textBlock("failed"), attachment];
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
      expect(blocks).toContainEqual(textBlock("Before calls"));
      expect(blocks).toContainEqual(textBlock("After calls"));
      expect(
        blocks.findIndex((block) => requireRecord(block).text === "Before calls"),
      ).toBeLessThan(blocks.findIndex((block) => requireRecord(block).id === "a"));
      expect(
        blocks.findIndex((block) => requireRecord(block).text === "After calls"),
      ).toBeGreaterThan(blocks.findLastIndex((block) => requireRecord(block).id === "b"));
    });

    it("keeps surrounding text in order when result references split a multi-call message", () => {
      const groups = messageGroups({
        messages: [
          assistant(
            [
              textBlock("before"),
              toolCall("a"),
              textBlock("between"),
              toolCall("b"),
              textBlock("after"),
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
          assistant(
            [
              toolCall("a", "exec", { command: "one" }),
              { type: "toolresult", name: "exec", text: "one done" },
              toolCall(undefined, "exec", { command: "two" }),
              { type: "toolresult", name: "exec", text: "two done" },
            ],
            10,
          ),
        ],
        [snapshot("a")],
      );
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
          assistant(
            [
              toolCall("a"),
              toolCall("b"),
              toolCall("conflict", "read", { path: "a" }),
              toolCall("conflict", "exec", { command: "pwd" }),
            ],
            10,
            { runId: "run-a" },
          ),
          resultMessage("conflict", "read", "read output", 20, { runId: "run-a" }),
          result("conflict", "exec output"),
        ],
        live,
      );
      expect(cards.slice(0, 2).map((card) => card.liveDiffStat)).toEqual([
        { added: 1, removed: 0 },
        { added: 2, removed: 0 },
      ]);
      expect(cards.slice(2).map((card) => [card.name, card.outputText])).toEqual([
        ["read", "read output"],
        ["exec", "exec output"],
      ]);
    });
  });

  it("keeps more than sixteen parallel calls open by call id", () => {
    const groups = messageGroups({
      messages: [
        ...Array.from({ length: 17 }, (_, index) =>
          toolUseMessage(`call-${index}`, "read", { path: `${index}.ts` }, 1000 + index),
        ),
        resultMessage("call-0", "read", [textBlock("first contents")], 1017),
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

  it("deduplicates relay copies by canonical identity before surface ids", () => {
    const groups = messageGroups({
      messages: [
        assistant([textBlock("Parzival Ship it.")], 1, {
          id: "relay-surface-copy",
          __openclaw: { id: "reply" },
          senderLabel: "Parzival",
        }),
        assistant([textBlock("Ship it.")], 2, {
          id: "native-surface-copy",
          __openclaw: { id: "reply" },
        }),
      ],
    });
    expect(groups).toMatchObject([{ senderLabel: null, messages: [{}] }]);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([textBlock("Ship it.")]);
  });

  it.each(["incomplete imports", "canonical replay", "distinct IDs", "missing IDs"])(
    "deduplicates user prompts only with proven identity: %s",
    (source) => {
      const canonical = {
        id: "canonical-replayed-user",
        idempotencyKey: "replayed-user-run:user",
        seq: 1,
      };
      const groups = messageGroups({
        messages: [1, 2].map((timestamp) =>
          user([textBlock("Same prompt")], timestamp, {
            __openclaw:
              source === "missing IDs"
                ? undefined
                : source === "incomplete imports"
                  ? {
                      id: "provider-local-user",
                      externalId: "provider-local-user",
                      importedFrom: "claude-cli",
                    }
                  : {
                      ...canonical,
                      id: source === "distinct IDs" ? `user-${timestamp}` : canonical.id,
                    },
          }),
        ),
      });
      expect(groups).toHaveLength(1);
      const group = groupAt(groups, 0);
      expect(group.messages.map((entry) => normalizeMessage(entry.message).timestamp)).toEqual(
        source === "canonical replay" ? [1] : [1, 2],
      );
      if (source === "canonical replay") {
        expect(persistedMessageEntryId(messageRecord(group))).toBe(canonical.id);
      }
    },
  );

  it("suppresses assistant HEARTBEAT_OK acknowledgements before rendering history", () => {
    const groups = messageGroups({
      messages: [
        assistant([textBlock("HEARTBEAT_OK")], 1),
        assistant("HEARTBEAT_OK", 2),
        user([textBlock("HEARTBEAT_OK")], 3),
        assistant([textBlock("Visible reply")], 4),
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groupAt(groups, 0).role).toBe("user");
    expect(groupAt(groups, 1).role).toBe("assistant");
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([textBlock("Visible reply")]);
  });

  it.each(["HEARTBEAT_OK", SENDER_METADATA_BLOCK])(
    "suppresses active metadata-only streams: %s",
    (stream) => {
      expect(buildItems({ stream, streamStartedAt: 1 })).toStrictEqual([]);
    },
  );

  it("preserves cumulative stream text and cache identity around an unkeyed preamble", () => {
    const paneId = "persisted prefix around an unkeyed preamble";
    const input = createProps({
      paneId,
      streamStartedAt: 5,
      messages: [assistant("First thought.", 1)],
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
    });
    const streamTexts = (items: ReturnType<typeof buildCachedChatItems>) =>
      items.flatMap((item) => (item.kind === "stream" ? [item.text] : []));
    const nextText = ["Standalone preamble", "After tool.", "Continued. Again."];
    const initial = buildCachedChatItems(input);
    expect(streamTexts(initial)).toEqual(["Standalone preamble", "After tool.", "Continued."]);
    const next = { ...input, stream: "First thought. After tool. Continued. Again." };
    const cached = buildCachedChatItems(next);
    expect(cached).toBe(initial);
    expect(streamTexts(cached)).toEqual(nextText);
    expect(streamTexts(buildCachedChatItems({ ...next, messages: [...next.messages] }))).toEqual(
      nextText,
    );
  });

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
        resultMessage("call-read", "read", "file contents", 1_000),
        resultMessage("call-list", "list", "file list", 1_000),
      ],
    });

    expect(items).toMatchObject([
      { kind: "stream", text: "Setup", startedAt: 1_500 },
      { kind: "stream", text: "First tool." },
      { kind: "group", messages: [{ message: { toolCallId: "call-read" } }] },
      { kind: "stream", text: "Second tool." },
      { kind: "group", messages: [{ message: { toolCallId: "call-list" } }] },
      { kind: "stream", text: "Unmatched preamble" },
      { kind: "stream", text: "Keyed preamble" },
    ]);
  });

  it("renders visible rows while filtering malformed or empty history, even with attribution", () => {
    const visible = assistant("still visible", 1);
    const forwarded = assistant([textBlock("")], 2, { senderLabel: "Forwarded from main" });
    const groups = messageGroups({
      messages: [null, {}, user(SENDER_METADATA_BLOCK, 0), visible, forwarded],
    });
    expect(groups).toMatchObject([{ role: "assistant", messages: [{ message: visible }] }]);
  });

  it("does not expose malformed tool stream entries to message rendering", () => {
    const groups = messageGroups({
      toolMessages: [null, undefined, assistant([toolCall(undefined, "heartbeat_respond")], 1)],
    });
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

  it("keeps an attempted pending send after the preceding reply", () => {
    const groups = messageGroups({
      messages: [assistant("Previous reply", 2)],
      queue: [
        queuedSend("attempted-send-1", "retry me from the transcript", 1, "waiting-reconnect", {
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
      state: "waiting-reconnect",
      error: "Delivery diagnostic",
    });
  });

  it.each([
    {
      name: "nearest assistant turn",
      props: {
        messages: [
          chatMessage("assistant", undefined, 1_000, {
            id: "assistant-with-canvas",
            text: "First reply.",
          }),
          assistant([textBlock("Later unrelated reply.")], 2_000, {
            id: "assistant-without-canvas",
          }),
        ],
      },
      app: toolMessage(
        "call-canvas-old",
        "canvas_render",
        canvasToolOutput("cv_nearest_turn", "Nearest turn demo", 320),
        1_001,
        { id: "tool-canvas-for-first-reply" },
      ),
      showToolCalls: true,
      order: null,
      canvases: [1, 0],
    },
    {
      name: "recovery turn after a system notice",
      props: {
        messages: [
          user("Interrupted request", 1_000),
          assistant("Interrupted reply", 2_000),
          user("[System] Continue the interrupted turn.", 3_000, {
            provenance: { kind: "internal_system", sourceTool: "system-event" },
          }),
        ],
      },
      app: mcpAppResult("mcp-app-recovery", "call-recovery", 3_001),
      order: ["user", "assistant", "notice", "assistant"],
      canvases: [null, 0, 1],
    },
    {
      name: "silent turn before the next user prompt",
      props: {
        messages: [user("Show the App", 1_000), user("Next request", 2_000)],
      },
      app: mcpAppResult("mcp-app-earlier", "call-earlier", 1_001),
      order: ["user", "assistant", "user"],
      canvases: [null, 1],
    },
    {
      name: "queued user prompt before its future follow-up",
      props: {
        messages: [user("First request", 1_000), assistant("First response", 1_001)],
        queue: [
          queuedSend("queued-app-turn", "Show the App", 2_000, "waiting-model", {
            sendSubmittedAtMs: 2_000,
          }),
          queuedSend("queued-future-turn", "Later request", 2_001, "waiting-reconnect", {
            sendSubmittedAtMs: 2_001,
            sendAttempts: 1,
          }),
        ],
      },
      app: mcpAppResult("mcp-app-queued", "call-queued", 2_002),
      order: ["user", "assistant", "user", "assistant", "user"],
      canvases: [null, null, null, 1],
    },
  ] satisfies {
    name: string;
    props: Partial<CachedChatItemsProps>;
    app: unknown;
    showToolCalls?: boolean;
    order: string[] | null;
    canvases: (number | null)[];
  }[])(
    "places a lifted App preview in its $name",
    ({ props, app, showToolCalls = false, order, canvases }) => {
      const items = buildItems({ ...props, toolMessages: [app], showToolCalls });
      if (order) {
        expectRoles(items, order);
      }
      const groups = groupsIn(items);
      for (const [index, count] of canvases.entries()) {
        if (count !== null) {
          expect(canvasBlocksIn(groupAt(groups, index))).toHaveLength(count);
        }
      }
    },
  );

  it("keeps a persisted App preview on an assistant search match", () => {
    for (const showToolCalls of [false, true]) {
      const groups = messageGroups({
        messages: [
          user("Show the App", 1_000),
          mcpAppResult("mcp-app-persisted-search", "call-persisted-search", 1_001),
          assistant("Matching preview", 1_002),
        ],
        toolMessages: [],
        searchOpen: true,
        searchQuery: "matching",
        showToolCalls,
      });

      const assistantGroup = groups.find((group) => group.role === "assistant");
      expect(assistantGroup).toBeDefined();
      expect(canvasBlocksIn(assistantGroup as MessageGroup)).toHaveLength(1);
    }
  });

  it("deduplicates Gateway-embedded previews by Canvas URL alone", () => {
    const text = "The App is ready.";
    const groups = messageGroups({
      messages: [
        user("Show the Apps", 1_000),
        resultMessage(
          "call-url-match",
          "show_widget",
          canvasToolOutput("cv_url_match", "URL match", 320),
          1_001,
        ),
        assistant(
          [
            textBlock(text),
            canvasBlock({ url: "/__openclaw__/canvas/documents/cv_url_match/index.html" }),
          ],
          1_003,
        ),
      ],
      showToolCalls: false,
    });
    expect(groups.flatMap(canvasBlocksAcross)).toHaveLength(1);
    expect(groups.flatMap(normalizedBlocks)).toContainEqual(textBlock(text));
  });

  it.each(["mcp", "board"])("preserves rich %s metadata over a shortcode", (kind) => {
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
        : resultMessage(callId, "show_widget", boardOutput, 1_002);
    const shortcodeReply = assistant(
      [textBlock(`[embed ref="${viewId}" title="Widget" /]\n\nReady.`)],
      1_003,
    );
    const original = structuredClone(shortcodeReply);
    const history = kind === "mcp" ? [shortcodeReply] : [result, shortcodeReply];
    const groups = messageGroups({
      messages: [user("Show a widget", 1_000), ...history],
      toolMessages: kind === "mcp" ? [mcpAppLiveResult(viewId, callId, 1_002)] : [],
      showToolCalls: false,
    });

    const previews = groups.flatMap(canvasBlocksAcross);
    expect(previews).toMatchObject([
      {
        type: "canvas",
        preview:
          kind === "mcp"
            ? {
                viewId,
                sandbox: "scripts",
                mcpApp: mcpAppDescriptor(viewId, callId),
              }
            : { viewId, url, sandbox: "strict", boardWidgetName: "saved-widget" },
      },
    ]);
    expect(groups.flatMap(normalizedBlocks)).toContainEqual(textBlock("\n\nReady."));
    expect(shortcodeReply).toEqual(original);
  });
  it.each([
    { persisted: "none", parent: "exec-widget", viewId: "cv_nested", count: 1 },
    { persisted: "wrapper", parent: "exec-widget", viewId: "cv_nested", count: 1 },
    { persisted: "both", parent: "exec-widget", viewId: "cv_nested", count: 1 },
    { persisted: "none", parent: "exec-widget", viewId: "cv_distinct", count: 2 },
    { persisted: "wrapper", parent: "another-exec", viewId: "cv_nested", count: 2 },
  ])(
    "reconciles nested previews (saved=$persisted): $parent / $viewId",
    ({ persisted, parent, viewId, count }) => {
      const wrapper = resultMessage(
        "exec-widget",
        "exec",
        canvasToolOutput("cv_nested", "Counter", 100),
        1_001,
      );
      const nested = assistant(
        [
          {
            type: "toolresult",
            name: "show_widget",
            parentToolCallId: parent,
            text: canvasToolOutput(viewId, "Counter", 100),
          },
        ],
        1_004,
        { toolCallId: "nested-widget" },
      );
      const saved = [
        user("Show a counter", 999),
        assistant("Preparing it.", 1_000),
        wrapper,
        assistant("Ready.", 1_005),
      ];
      const messages =
        persisted === "both"
          ? [...saved.slice(0, 2), nested, ...saved.slice(2)]
          : persisted === "wrapper"
            ? saved
            : saved.filter((message) => message !== wrapper);
      const original = structuredClone(messages);
      const groups = messageGroups({
        messages,
        toolMessages:
          persisted === "both" ? [] : persisted === "wrapper" ? [nested] : [wrapper, nested],
        showToolCalls: false,
      });

      expect(groups.flatMap(canvasBlocksAcross)).toHaveLength(count);
      expect(
        messageGroups({ messages: saved, toolMessages: [], showToolCalls: false }).flatMap(
          canvasBlocksAcross,
        ),
      ).toHaveLength(1);
      expect(messages).toEqual(original);
    },
  );

  it.each([
    { savedReceipt: false },
    {},
    { tailFirst: true },
    { shortcode: "string", reload: true },
    { shortcode: "text", reload: true },
    { shortcode: true, otherShortcode: true, count: 2, reload: true },
    { steer: true },
    { steer: true, includeOriginal: false },
    { steer: true, savedReply: false },
    { search: true },
    { finalRun: "other-run", count: 2 },
    { finalView: "cv_other", count: 2 },
    { live: false, count: 2 },
  ])(
    "reconciles only the owned final Canvas tail: %j",
    async ({
      savedReceipt = true,
      finalRun = "final-widget-run",
      finalView = "cv_final",
      live = true,
      count = 1,
      tailFirst = false,
      shortcode = false,
      otherShortcode = false,
      steer = false,
      includeOriginal = true,
      savedReply = true,
      search = false,
      reload = false,
    }) => {
      const runId = "final-widget-run";
      const parentToolCallId = "call_widget|fc_widget";
      const output = canvasToolOutput("cv_final", "Counter", 100);
      const nested = {
        role: "custom",
        runId,
        timestamp: 1_002,
        __openclaw: { id: "nested-receipt", seq: 2, runId },
        content: [
          { type: "toolCall", id: "nested-widget", name: "show_widget", runId, parentToolCallId },
          {
            type: "toolResult",
            role: "toolResult",
            toolCallId: "nested-widget",
            toolName: "show_widget",
            runId,
            parentToolCallId,
            content: [{ type: "text", text: output }],
          },
        ],
      };
      const canvas = canvasBlock({ viewId: "cv_final" });
      const saved = assistant([textBlock("Your counter is ready."), canvas], 1_003, {
        __openclaw: { id: "saved-final", seq: 3, runId },
      });
      const final = assistant(
        [
          textBlock(
            "Final tail." +
              (shortcode ? ' [embed ref="cv_final" /]' : "") +
              (otherShortcode ? ' [embed ref="cv_other" /]' : ""),
          ),
          { ...canvas, preview: { ...canvas.preview, viewId: finalView } },
        ],
        1_005,
        { __openclaw: { runId: finalRun } },
      );
      if (shortcode === "string") {
        final.content = 'Final tail. [embed ref="cv_final" /]';
      }
      const source =
        shortcode === "text"
          ? normalizeFinalAssistantMessage({
              role: "assistant",
              text: 'Final tail. [embed ref="cv_final" /]',
              timestamp: 1_005,
            })
          : final;
      const terminal = live ? rememberLiveTerminalRun(source, finalRun) : source;
      const messages = [
        ...(includeOriginal ? [nativeUser(runId, "Show a counter", 1_000, { runId })] : []),
        ...(tailFirst ? [terminal] : []),
        ...(savedReceipt ? [nested] : []),
        ...(savedReply ? [saved] : []),
        ...(steer
          ? [
              nativeUser("steer-input", "Keep going", 1_004, {
                id: "steer",
                seq: 4,
                steerTargetRunId: runId,
              }),
            ]
          : []),
        ...(tailFirst ? [] : [terminal]),
      ];
      const original = structuredClone(messages);
      const terminalRevision = readLiveTerminalRevision();
      const cached = reload
        ? await createSnapshotRecord("widget-session", {
            savedAt: 1_006,
            snapshot: {
              messages,
              pagination: { hasMore: false },
              sessionId: "widget-session",
              historyState: { stateRevision: { pendingInputs: "inputs-1" } },
            },
          })
        : null;
      if (reload) {
        expect(cached?.record.snapshot.historyState).toBeUndefined();
        expect(cached?.record.snapshot.messages.map(extractText).join("\n")).not.toContain(
          'ref="cv_final"',
        );
      }
      const groups = messageGroups({
        messages: cached?.record.snapshot.messages ?? messages,
        toolMessages: savedReceipt ? [] : [nested],
        showToolCalls: true,
        searchOpen: search,
        searchQuery: search ? "Final tail." : "",
      });
      expect(groups.flatMap(canvasBlocksAcross)).toHaveLength(count);
      if (!search) {
        expect(cardsIn(groups).some((card) => card.callId === "nested-widget")).toBe(true);
      }
      expect(
        groups
          .flatMap(normalizedBlocks)
          .flatMap((block) => (block.type === "text" ? [block.text?.trim()] : [])),
      ).toContain("Final tail.");
      if (savedReply && !search) {
        expect(groups.flatMap(normalizedBlocks)).toContainEqual(
          textBlock("Your counter is ready."),
        );
      }
      expect(messages).toEqual(original);
      expect(readLiveTerminalRevision()).toBe(terminalRevision);
    },
  );

  it("keeps live previews when separate runs reuse a call and view ID", () => {
    const groups = messageGroups({
      messages: [
        nativeUser("first", "First App", 1_000, { runId: "first" }),
        assistant("First reply", 1_002),
        nativeUser("second", "Show it again", 2_000, { runId: "second" }),
        assistant("Second reply", 2_002),
      ],
      toolMessages: [
        { ...mcpAppLiveResult("shared-view", "shared-call", 1_001), runId: "first" },
        { ...mcpAppLiveResult("shared-view", "shared-call", 2_001), runId: "second" },
      ],
      showToolCalls: false,
    });
    expect(groups.flatMap(canvasBlocksAcross)).toHaveLength(2);
    expect(canvasBlocksIn(groupAt(groups, 1))).toHaveLength(1);
    expect(canvasBlocksIn(groupAt(groups, 3))).toHaveLength(1);
  });

  it("deduplicates untimestamped echoes without merging reused call IDs across turns", () => {
    const persisted = { ...mcpAppResult("first", "shared", 1_001), timestamp: undefined };
    const groups = messageGroups({
      messages: [user("First App", 1_000), persisted, user("Second App", 2_000)],
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
    const group = preparedGroup("assistant-stable", assistant("No tools in this row"));
    const items = [group];
    const extractSpy = vi.spyOn(toolCards, "extractToolCardsCached");
    syncToolCardExpansionState("identity-stable", items, false);
    const callsAfterFirstSync = extractSpy.mock.calls.length;
    syncToolCardExpansionState("identity-stable", items, false);
    expect(callsAfterFirstSync).toBeGreaterThan(0);
    expect(extractSpy).toHaveBeenCalledTimes(callsAfterFirstSync);
  });

  it("auto-expands top-level tool-name result disclosures", () => {
    const group = preparedGroup(
      "tool-name-result",
      assistant("Tool output", undefined, { toolName: "bash" }),
    );

    syncToolCardExpansionState("tool-name-session", [group], true);

    expect(getExpandedToolCards("tool-name-session").get("toolmsg:tool-name-result")).toBe(true);
  });
});

describe("expansion-state render dependencies", () => {
  it("reads unchanged tool and user expansion maps without locale sorting", () => {
    const tools = getExpandedToolCards("fast-session");
    const users = getExpandedUserMessages("fast-session");
    for (let index = 0; index < 128; index += 1) {
      setExpansionState(tools, `tool-${127 - index}`, index % 2 === 0);
      setExpansionState(users, `user-${127 - index}`, index % 2 === 0);
    }
    const compare = vi.spyOn(String.prototype, "localeCompare");
    expect(getExpansionStateVersion(tools)).toBe(tools.size);
    expect(getExpansionStateVersion(users)).toBe(users.size);
    expect(compare.mock.calls.length).toBe(0);
  });

  it("shares user-message render versions across equivalent session aliases", () => {
    setExpansionState(getExpandedUserMessages("main"), "user-message", true);

    expect(getExpansionStateVersion(getExpandedUserMessages("main"))).toBe(1);
    expect(getExpansionStateVersion(getExpandedUserMessages("agent:main:main"))).toBe(1);

    setExpansionState(getExpandedUserMessages("agent:main:main"), "user-message", false);
    expect(getExpansionStateVersion(getExpandedUserMessages("main"))).toBe(2);
    expect(getExpandedUserMessages("main").get("user-message")).toBe(false);
  });

  it("prunes implicit defaults when the same visible projection becomes complete", () => {
    const sessionKey = "search-removes-hidden-card";
    const group = (key: string) =>
      preparedGroup(
        key,
        assistant([{ type: "toolcall", id: `call-${key}`, name: "browser.open" }]),
      );
    const hidden = group("hidden-card");
    const visible = group("visible-card");
    const visibleProjection = [visible];
    syncToolCardExpansionState(sessionKey, [hidden, visible], false);
    const expanded = getExpandedToolCards(sessionKey);
    const hiddenCardId = "hidden-card:toolcard:0";
    syncToolCardExpansionState(sessionKey, visibleProjection, false, true);
    expect(expanded.get(hiddenCardId)).toBe(false);
    const filteredVersion = getExpansionStateVersion(expanded);

    syncToolCardExpansionState(sessionKey, visibleProjection, false);

    expect(expanded.has(hiddenCardId)).toBe(false);
    expect(expanded.has("visible-card:toolcard:0")).toBe(true);
    expect(getExpansionStateVersion(expanded)).toBe(filteredVersion + 1);
  });

  it("retains explicit choices when sibling panes have different loaded history", () => {
    const sessionKey = "split-history-disclosures";
    const group = (key: string) =>
      preparedGroup(
        key,
        assistant([{ type: "toolcall", id: `call-${key}`, name: "browser.open" }]),
      );
    const older = group("older-card");
    const recent = group("recent-card");
    const complete = [older, recent];
    const partial = [recent];
    syncToolCardExpansionState(sessionKey, complete, false);
    const expanded = getExpandedToolCards(sessionKey);
    const notify = vi.fn();
    const unsubscribe = subscribeExpansionState(expanded, notify);
    try {
      setExpansionState(expanded, "older-card:toolcard:0", true);
      expect(notify).toHaveBeenCalledTimes(1);

      syncToolCardExpansionState(sessionKey, partial, false);
      syncToolCardExpansionState(sessionKey, complete, false);

      expect(expanded.get("older-card:toolcard:0")).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
      setExpansionState(expanded, "older-card:toolcard:0", false);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("auto-expands retained cards hidden while transcript search is active", () => {
    const sessionKey = "search-auto-expands-hidden-cards";
    const reply = (visibility: string, text: string) =>
      assistant([
        textBlock(text),
        { type: "toolcall", id: `${visibility}-call`, name: "browser.open" },
      ]);
    const messages = [
      reply("hidden", "hidden assistant reply"),
      user("another turn"),
      reply("visible", "needle visible reply"),
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
});

describe("thread item cache", () => {
  it("repositions an initial placement prompt when recovery identifies its existing queue row", () => {
    const queued = queuedSend("initial", "Original request", 10_000, "failed", {
      sendRunId: "initial",
      sendAttempts: 1,
    });
    const input = createProps({
      messages: [assistant("Gateway recovery", 2)],
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
    const read = vi.fn(Reflect.get);
    const messages = Array.from(
      { length: 1_000 },
      (_, index) =>
        new Proxy(chatMessage(index % 2 === 0 ? "user" : "assistant", `message ${index}`, index), {
          get: read,
        }),
    );
    const input = createProps({
      messages,
      stream: "partial reply",
      streamStartedAt: 10,
    });
    const first = buildCachedChatItems(input);
    read.mockClear();

    const updated = buildCachedChatItems({ ...input, stream: "complete reply" });

    expect(updated).toBe(first);
    expect(read).not.toHaveBeenCalled();
    expect(updated).toContainEqual(
      expect.objectContaining({ kind: "stream", text: "complete reply", isStreaming: true }),
    );
  });

  it("keeps same-session render caches isolated between panes", () => {
    const messages = [assistant("needle"), user("other")];
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
  return canvasBlock({
    viewId,
    title: "Demo App",
    url: `/__openclaw__/canvas/documents/${viewId}/index.html`,
    sandbox: "scripts",
    mcpApp: mcpAppDescriptor(viewId, toolCallId),
  });
}

function mcpAppResult(viewId: string, toolCallId: string, timestamp: number) {
  return resultMessage(toolCallId, "demo__show", [textBlock("ok")], timestamp, {
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
  return assistant(
    [
      toolCall(undefined, "demo__show"),
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
      { type: "toolResult", toolCallId: id, name, content: [textBlock("done")] },
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
    const rendered = messagesIn(groupsIn(items));
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
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
