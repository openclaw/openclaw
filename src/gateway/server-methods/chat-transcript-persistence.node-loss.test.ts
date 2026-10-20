import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, it, expect } from "vitest";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  captureAbortedPartial,
  persistAbortedPartials,
} from "./chat-transcript-persistence.runtime.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-node-loss-transcript-");

function appendTranscriptMessage(params: {
  sessionId: string;
  storePath: string;
  idempotencyKey: string;
  message: object;
}) {
  const result = appendTranscriptMessageSync(
    {
      agentId: "main",
      sessionKey: "main",
      sessionId: params.sessionId,
      storePath: params.storePath,
    },
    {
      idempotencyLookup: "caller-checked",
      message: { ...params.message, idempotencyKey: params.idempotencyKey },
      now: 1,
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok || !result.value?.anchor) {
    throw new Error("Expected committed transcript anchor");
  }
  return result.value.anchor;
}

it.each(["", "Partial reply"])(
  "saves outcome-unknown results for each unfinished tool with partial text %j",
  async (text) => {
    const sessionId = "node-loss-session";
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const scope = { agentId: "main", sessionKey: "main", sessionId, storePath };
    const runId = "node-lost-run";
    await replaceSessionEntry(
      { agentId: "main", storePath, sessionKey: "main" },
      { sessionId, updatedAt: 1, activeWriterRunId: runId },
    );
    const originalInput = appendTranscriptMessage({
      sessionId,
      storePath,
      idempotencyKey: "original-request",
      message: { role: "user", content: "run the command", timestamp: 0 },
    });
    appendTranscriptMessage({
      sessionId,
      storePath,
      idempotencyKey: "tool-request",
      message: makeAgentAssistantMessage({
        stopReason: "toolUse",
        content: ["done", "lost-a", "lost-b"].map((id) => ({
          type: "toolCall",
          id,
          name: "exec",
          arguments: { command: id },
        })),
      }),
    });
    appendTranscriptMessage({
      sessionId,
      storePath,
      idempotencyKey: "done-result",
      message: {
        role: "toolResult",
        toolCallId: "done",
        toolName: "exec",
        content: [{ type: "text", text: "Completed" }],
        isError: false,
        timestamp: 1,
      },
    });
    const snapshot = captureAbortedPartial({
      session: {
        ok: true,
        value: {
          cfg: {},
          storePath,
          canonicalKey: "main",
          agentId: "main",
          entry: { sessionId, updatedAt: 1, activeWriterRunId: runId },
        },
      },
      sessionKey: "main",
      sessionId,
      runId,
      text,
      abortOrigin: "placement-abandon",
    });
    const missingToolResultText =
      "The node disconnected; outcome unknown. Verify state before retrying.";
    const persist = () =>
      runWithSessionTranscriptReadFence(
        { ...originalInput, logicalTurnId: runId, role: "user" },
        () =>
          persistAbortedPartials({
            context: { logGateway: { warn: () => {} } },
            snapshots: [snapshot],
            missingToolResultText,
          }),
      );
    await persist();
    await persist();
    const lines = await loadTranscriptEvents(scope);
    const messages = lines.flatMap((line) =>
      isRecord(line) && line.type === "message" && isRecord(line.message) ? [line.message] : [],
    );
    const results = messages.filter((message) => message.role === "toolResult");
    expect(results).toMatchObject([
      { toolCallId: "done", isError: false },
      { toolCallId: "lost-a", isError: true, content: [{ text: missingToolResultText }] },
      { toolCallId: "lost-b", isError: true, content: [{ text: missingToolResultText }] },
    ]);
    expect(results).toHaveLength(3);
    expect(
      messages.filter(
        (message) => message.role === "assistant" && JSON.stringify(message).includes('"text":'),
      ),
    ).toHaveLength(text ? 1 : 0);
  },
);
