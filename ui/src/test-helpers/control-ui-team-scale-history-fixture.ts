import type { Buffer } from "node:buffer";
import type { AgentsListResult, GatewaySessionRow } from "../api/types.ts";
import type {
  ChatHistoryDeltaResult,
  ChatHistoryResult,
} from "../pages/chat/chat-history-snapshot.ts";
import type { createTeamScaleDuplicateReadFixture } from "./control-ui-duplicate-read-fixture.ts";

export type FixtureAsset = {
  body: string | Buffer;
  contentType: string;
  status?: number;
  delayMs?: number;
  headers?: Record<string, string>;
};

export function installTeamScaleChatPaneAvatar(
  agents: AgentsListResult,
  assets: Map<string, FixtureAsset>,
): string {
  const avatar = "/avatar/main?v=l201-fixture-v1";
  agents.agents[0]!.identity = { name: "Harbor", avatarUrl: avatar };
  assets.set("/avatar/main", {
    contentType: "image/svg+xml",
    headers: { "Cache-Control": "private, max-age=31536000, immutable" },
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="8" fill="#386b88"/><circle cx="20" cy="20" r="11" fill="#e9f3fa"/></svg>',
  });
  return avatar;
}

export function createTeamScaleHistoryResponse(
  messages: unknown[],
  sessionInfo: GatewaySessionRow,
  totalMessages: number,
  options: { historyStateReceipt?: boolean; chatPaneOneStep?: boolean },
) {
  const stateRevision = {
    sessionInfo: "fixture-session-v1",
    commands: "fixture-commands-v1",
    ...(options.chatPaneOneStep ? { pendingInputs: "fixture-inputs-v1" } : {}),
  };
  const deltaCursor = "team-scale-chat-pane-v1";
  const pendingInputs = { items: [], total: 0, queuedCount: 0 };
  const metadata = { commands: [], models: [] };
  const full = {
    messages,
    sessionId: sessionInfo.sessionId,
    sessionInfo,
    hasMore: false,
    totalMessages,
    metadata,
    ...(options.historyStateReceipt || options.chatPaneOneStep ? { stateRevision } : {}),
    ...(options.chatPaneOneStep ? { deltaCursor, pendingInputs } : {}),
  } satisfies ChatHistoryResult;
  if (!options.chatPaneOneStep) {
    return full;
  }
  const delta = {
    kind: "delta",
    messages: [],
    deltaCursor,
    sessionInfo,
    sessionInfoSnapshotAt: sessionInfo.snapshotAt,
    stateRevision,
    metadata: {},
  } satisfies ChatHistoryDeltaResult;
  return { cases: [{ match: { cursor: deltaCursor }, response: delta }, { response: full }] };
}

export function createTeamScaleHistoryFixture(options: {
  messageCount: number;
  inlineWidgets: number;
  now: number;
  largeSnapshot?: boolean;
  chatPaneOneStep?: boolean;
  attachments?: ReturnType<typeof createTeamScaleDuplicateReadFixture>["attachments"];
}) {
  if (options.chatPaneOneStep) {
    const historyMessages: unknown[] = [];
    const append = (message: Record<string, unknown>) => {
      const index = historyMessages.length;
      historyMessages.push({
        ...message,
        timestamp: options.now - 60_000 + index * 1_000,
        __openclaw: { id: `team-message-${index + 1}`, seq: index + 1 },
      });
    };
    for (let turn = 0; turn < 6; turn++) {
      const id = `synthetic-review-${turn}`;
      append({ role: "user", content: `Check synthetic project ${turn + 1}.` });
      append({
        role: "assistant",
        content: [
          ...(turn % 2 === 0
            ? [{ type: "text", text: "Reviewing the synthetic work queue." }]
            : []),
          { type: "toolCall", id, name: "exec", arguments: { command: "printf ready" } },
          ...(turn % 2
            ? [
                {
                  type: "toolCall",
                  id: `${id}-read`,
                  name: "read",
                  arguments: { path: "/workspace/check.txt" },
                },
              ]
            : []),
        ],
        stopReason: "toolUse",
      });
      append({
        role: "toolResult",
        toolCallId: id,
        toolName: "exec",
        content: [{ type: "text", text: "Synthetic verification completed." }],
        activity: [
          {
            itemId: `tool:${id}`,
            toolCallId: id,
            kind: "tool",
            phase: "end",
            status: "completed",
            title: "Verify synthetic work",
          },
        ],
        details: {
          approvalReviewOutcome: "approved",
          approvalReviews: [{ id, label: "Reviewer", status: "approved" }],
        },
      });
      if (turn % 2) {
        append({
          role: "toolResult",
          toolCallId: `${id}-read`,
          toolName: "read",
          content: [{ type: "text", text: "Synthetic check is ready." }],
          activity: [
            {
              itemId: `tool:${id}-read`,
              toolCallId: `${id}-read`,
              kind: "tool",
              phase: "end",
              status: "completed",
              title: "Read synthetic check",
            },
          ],
        });
      }
      // Reply-less turns keep their activity exposed instead of a completed Worked rollup.
      if (turn % 2 === 0) {
        append({ role: "assistant", content: "The synthetic project is ready for verification." });
      }
    }
    append({
      role: "custom",
      content: "The synthetic service could not finish the final check.",
      openclawRunError: {
        runId: "synthetic-failed-run",
        summary: "The synthetic service could not finish the final check.",
      },
    });
    return {
      messageIds: historyMessages.map((_message, index) => `team-message-${index + 1}`),
      historyMessages,
    };
  }
  const messageIds = Array.from(
    { length: options.messageCount },
    (_, index) => `team-message-${index + 1}`,
  );
  const messagesPerWidget = Math.ceil(options.messageCount / options.inlineWidgets);
  const historyMessages = messageIds.map((id, index) => ({
    role:
      options.largeSnapshot && index % 4 === 2 ? "toolResult" : index % 2 ? "assistant" : "user",
    __openclaw: { id, seq: index + 1 },
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
  return { messageIds, historyMessages };
}
