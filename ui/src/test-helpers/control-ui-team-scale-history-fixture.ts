import type { ModelCatalogEntry } from "../api/types.ts";
import type { ChatHistoryResult } from "../pages/chat/chat-history-snapshot.ts";
import type { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";

export function createTeamScaleHistoryFixture(options: {
  messageCount: number;
  inlineWidgets: number;
  now: number;
  largeSnapshot?: boolean;
  duplicateBootReads?: boolean;
  sessionInfo: ControlUiSessionFixture;
  sender?: ControlUiMockPresenceUser;
  rowFacts?: boolean;
  models: ModelCatalogEntry[];
  inFlightRun?: ChatHistoryResult["inFlightRun"];
  attachments?: ReturnType<typeof createTeamScaleDuplicateReadFixture>["attachments"];
}) {
  const messageIds = Array.from(
    { length: options.messageCount },
    (_, index) => `team-message-${index + 1}`,
  );
  const messagesPerWidget = Math.ceil(options.messageCount / options.inlineWidgets);
  const historyMessages = messageIds.map((id, index) => ({
    role:
      options.largeSnapshot && index % 4 === 2 ? "toolResult" : index % 2 ? "assistant" : "user",
    __openclaw: {
      id,
      seq: index + 1,
      ...(options.sender && index % 2 === 0 && !(options.largeSnapshot && index % 4 === 2)
        ? {
            senderIdentity: options.sender.identity,
            senderName: options.sender.name,
            senderProfileAvatarUrl: options.sender.avatarUrl,
          }
        : {}),
    },
    ...(options.largeSnapshot
      ? {
          idempotencyKey: `synthetic-message-${index}`,
          ...(index % 4 === 2 ? { toolCallId: `synthetic-tool-${index}`, toolName: "read" } : {}),
          openclawResponsesInputReplay: { text: "Synthetic replay metadata. ".repeat(10) },
          usage: { input: 1200, output: 400, totalTokens: 1600 },
        }
      : {}),
    timestamp: options.now - (options.messageCount - index) * 60_000,
    content: [
      ...(options.attachments && index === options.messageCount - 1 ? options.attachments : []),
      {
        type: "text",
        text: [
          `### Project checkpoint ${index + 1}`,
          "Review the synthetic work queue, confirm the dependency order, and record the owner of the next action. The fixture contains no real conversations or account data.",
          index % 2
            ? "The current implementation is ready for verification. Coverage includes the normal path, a recoverable failure, and the final user-visible result."
            : "Please check the current progress and keep the existing layout stable while the remaining results arrive.",
          ...(options.largeSnapshot
            ? ["Synthetic transcript detail and tool output. ".repeat(40)]
            : []),
          ...(index % messagesPerWidget === messagesPerWidget - 1 ||
          index === options.messageCount - 1
            ? [
                `[embed ref="team-scale-chart-${Math.floor(index / messagesPerWidget) + 1}" title="Team metric ${Math.floor(index / messagesPerWidget) + 1}" height="220" /]`,
              ]
            : []),
        ].join("\n\n"),
      },
    ],
  }));
  if (options.rowFacts) {
    const runId = "synthetic-row-facts-run";
    const tail = historyMessages.slice(-3);
    for (const message of tail) {
      const { __openclaw: identity } = message;
      Object.assign(message, { runId });
      Object.assign(identity, { runId });
    }
    Object.assign(tail[0]!, { role: "user" });
    Object.assign(tail[1]!, {
      role: "toolResult",
      toolCallId: "synthetic-row-facts-read",
      toolName: "read",
      content: [{ type: "text", text: "Synthetic verification output." }],
      activity: [
        {
          itemId: "tool:synthetic-row-facts-read",
          toolCallId: "synthetic-row-facts-read",
          kind: "tool",
          phase: "end",
          name: "read",
          title: "Read",
          status: "completed",
        },
      ],
    });
    Object.assign(tail[2]!, {
      model: "gpt-5-mini",
      usage: { input: 1200, output: 400, cost: { total: 0.01 } },
    });
    const id = "synthetic-row-facts-failure";
    const summary = "Synthetic verification failed; retry the check.";
    messageIds.push(id);
    historyMessages.push(
      Object.assign({}, historyMessages.at(-1)!, {
        role: "custom",
        customType: "run-failed-before-reply",
        content: [{ type: "text", text: summary }],
        openclawRunError: { runId, summary },
        __openclaw: { id, seq: options.messageCount + 1, runId },
        timestamp: options.now + 1,
      }),
    );
  }
  const deltaCursor = JSON.stringify([
    "team-scale-history-v1",
    options.sessionInfo.key,
    options.now,
    options.messageCount,
    options.largeSnapshot === true,
    options.duplicateBootReads === true,
  ]);
  const configuredHistory = {
    messages: historyMessages,
    sessionId: options.sessionInfo.sessionId,
    sessionInfo: options.sessionInfo,
    deltaCursor,
    pendingInputs: { items: [], total: 0, queuedCount: 0 },
    stateRevision: {
      sessionInfo: "fixture-session-v1",
      commands: "fixture-commands-v1",
      pendingInputs: "fixture-pending-inputs-v1",
    },
    ...(options.largeSnapshot
      ? {
          hasMore: false,
          totalMessages: historyMessages.length,
          metadata: { commands: [], models: [] },
        }
      : {
          thinkingLevel: null,
          metadata: { commands: [], models: options.models },
          ...(options.inFlightRun ? { inFlightRun: options.inFlightRun } : {}),
        }),
  };
  const selectedHistory = {
    cases: [
      {
        match: { sessionKey: options.sessionInfo.key, cursor: deltaCursor },
        response: {
          kind: "delta",
          messages: [],
          deltaCursor,
          sessionInfo: configuredHistory.sessionInfo,
          metadata: configuredHistory.metadata,
          pendingInputs: configuredHistory.pendingInputs,
          stateRevision: configuredHistory.stateRevision,
          ...(options.inFlightRun ? { inFlightRun: options.inFlightRun } : {}),
        },
      },
      {
        match: { sessionKey: options.sessionInfo.key, limit: 80, knownState: {} },
        response: {
          ...configuredHistory,
          messages: historyMessages.slice(-80),
          hasMore: historyMessages.length > 80,
          ...(historyMessages.length > 80 ? { nextOffset: 80 } : {}),
          totalMessages: historyMessages.length,
        },
      },
      { match: { sessionKey: options.sessionInfo.key }, response: configuredHistory },
    ],
  };
  return { messageIds, historyMessages, selectedHistory };
}
