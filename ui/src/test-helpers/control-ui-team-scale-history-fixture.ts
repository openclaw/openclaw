import type { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";
import type { ControlUiMockPresenceUser } from "./control-ui-mock-presence.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";

export function createTeamScaleHistoryFixture(options: {
  messageCount: number;
  inlineWidgets: number;
  now: number;
  largeSnapshot?: boolean;
  historyStateReceipt?: boolean;
  sessionInfo: ControlUiSessionFixture;
  sender?: ControlUiMockPresenceUser;
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
  const configuredHistory =
    options.largeSnapshot || options.historyStateReceipt
      ? {
          messages: historyMessages,
          sessionId: options.sessionInfo.sessionId,
          sessionInfo: options.sessionInfo,
          hasMore: false,
          totalMessages: options.messageCount,
          metadata: { commands: [], models: [] },
          ...(options.historyStateReceipt
            ? {
                stateRevision: {
                  sessionInfo: "fixture-session-v1",
                  commands: "fixture-commands-v1",
                },
              }
            : {}),
        }
      : undefined;
  return { messageIds, historyMessages, configuredHistory };
}
