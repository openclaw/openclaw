import { createNestedToolActivity } from "../../../src/sessions/nested-tool-activity.ts";
import { prepareChatHistoryFixture } from "./chat-activity-fixtures.ts";

export const interruptedChatRunId = "synthetic-interrupted-run";
export const interruptedChatPrompt = "Inspect the synthetic project and report your findings.";
export const interruptedChatCommentary = [
  "I found the relevant files and am checking their behavior.",
  "The checks are complete; I am preparing the findings.",
];

/** Persisted tool iterations, including narration, with no terminal assistant row. */
export function interruptedChatHistory() {
  const runId = interruptedChatRunId;
  const timestamp = Date.UTC(2026, 9, 12, 12);
  const messages: Record<string, unknown>[] = [];
  const append = (message: Record<string, unknown>) => {
    const seq = messages.length + 1;
    messages.push({
      ...message,
      __openclaw: {
        id: `synthetic-entry-${seq}`,
        seq,
        runId,
        ...(message.role === "user" ? { idempotencyKey: `${runId}:user` } : {}),
        ...(message.role === "assistant" ? { turnTainted: true } : {}),
        transcriptPosition: { source: "synthetic-snapshot", rawSeq: seq - 1 },
      },
    });
  };
  append({ role: "user", content: interruptedChatPrompt, timestamp });
  for (let index = 0; index < 26; index += 1) {
    const callId = `synthetic-exec-${index}`;
    const startedAt = timestamp + index * 4_000 + 1_000;
    const text =
      index === 9
        ? interruptedChatCommentary[0]
        : index === 22
          ? interruptedChatCommentary[1]
          : undefined;
    append({
      role: "assistant",
      stopReason: "toolUse",
      timestamp: startedAt,
      content: [
        ...(text ? [{ type: "text", text }] : []),
        {
          type: "toolCall",
          id: callId,
          name: "exec",
          arguments: {
            title: `Inspect fixture ${index + 1}`,
            code: "await tools.read({ path: 'fixture.txt' });",
          },
        },
      ],
    });
    for (let child = 0; child < 2; child += 1) {
      append(
        createNestedToolActivity({
          runId,
          scopeId: callId,
          afterEntryId: `synthetic-entry-${messages.length}`,
          startOrder: child,
          parentToolCallId: callId,
          toolCallId: `${callId}-read-${child}`,
          toolName: "read",
          input: { path: `fixture-${index}-${child}.txt` },
          result: { content: [{ type: "text", text: "Synthetic file contents." }] },
          isError: false,
          startedAt: startedAt + child * 500,
          timestamp: startedAt + child * 500 + 250,
        }),
      );
    }
    append({
      role: "toolResult",
      toolCallId: callId,
      toolName: "exec",
      content: [{ type: "text", text: "Synthetic inspection complete." }],
      timestamp: startedAt + 2_000,
    });
  }
  return prepareChatHistoryFixture(messages);
}
