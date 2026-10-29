import { expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { readStoredSessionRowTranscriptProjection } from "../gateway/session-row-transcript-preview.js";
import { attachSessionTranscriptRunId } from "./transcript-events.js";
import { readSessionTranscriptTerminalModel } from "./transcript-terminal-model.js";

it("does not report a command reply as the model that completed a run", () => {
  const message = attachSessionTranscriptRunId(
    makeAgentAssistantMessage({ content: [{ type: "text", text: "Completed" }] }),
    "run-1",
  );
  expect(readSessionTranscriptTerminalModel({ message })).toEqual({
    runId: "run-1",
    modelProvider: "openai",
    model: "test-model",
  });
  expect(
    readSessionTranscriptTerminalModel({
      message: { ...message, provider: "openclaw", model: "command" },
    }),
  ).toBeNull();
});

it("rebuilds cached terminal facts that attributed a command to an inference model", () => {
  const projection = {
    lastMessagePreview: "Command completed",
    lastAssistantMessage: null,
    terminalModel: { runId: "run-1", modelProvider: "openclaw", model: "command" },
    indexedSeq: 2,
  };
  expect(
    readStoredSessionRowTranscriptProjection({
      json: JSON.stringify(projection),
      updatedAt: 2,
      transcriptUpdatedAt: 2,
      indexedSeq: 2,
    }),
  ).toBeUndefined();
});
