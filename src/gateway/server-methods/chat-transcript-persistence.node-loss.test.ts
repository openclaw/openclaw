import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, it, expect } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
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

it.each(["", "Partial reply"])(
  "saves outcome-unknown results for each unfinished tool with partial text %j",
  async (text) => {
    const sessionId = "node-loss-session";
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const scope = { agentId: "main", sessionKey: "main", sessionId, storePath };
    const runId = "node-lost-run";
    const entry = { sessionId, updatedAt: 1, activeWriterRunId: runId };
    await replaceSessionEntry(scope, entry);
    const append = (idempotencyKey: string, message: object) => {
      const result = appendTranscriptMessageSync(scope, {
        idempotencyLookup: "caller-checked",
        message: { ...message, idempotencyKey },
        now: 1,
      });
      return expectDefined(result.ok ? result.value?.anchor : undefined, "committed anchor");
    };
    const originalInput = append("input", { role: "user", content: "run", timestamp: 0 });
    append(
      "tool-request",
      makeAgentAssistantMessage({
        stopReason: "toolUse",
        content: ["done", "lost-a", "lost-b"].map((id) => ({
          type: "toolCall",
          id,
          name: "exec",
          arguments: { command: id },
        })),
      }),
    );
    append("done-result", makeTextToolResult("done", "exec", "Completed", false, 1));
    const snapshot = captureAbortedPartial({
      session: {
        ok: true,
        value: { cfg: {}, storePath, canonicalKey: "main", agentId: "main", entry },
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
    const messages = (await loadTranscriptEvents(scope)).flatMap((line) =>
      isRecord(line) && line.type === "message" && isRecord(line.message) ? [line.message] : [],
    );
    const results = messages.filter((message) => message.role === "toolResult");
    expect(results).toMatchObject([
      { toolCallId: "done", isError: false },
      { toolCallId: "lost-a", isError: true, content: [{ text: missingToolResultText }] },
      { toolCallId: "lost-b", isError: true, content: [{ text: missingToolResultText }] },
    ]);
    expect(
      messages.filter(
        (message) => message.role === "assistant" && JSON.stringify(message).includes('"text":'),
      ),
    ).toHaveLength(text ? 1 : 0);
  },
);
