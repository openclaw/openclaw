import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import {
  validateWorkerTranscriptCommitParams,
  validateWorkerInferenceTerminalOutcome,
  WorkerInferenceContextSchema,
  WorkerTranscriptMessageSchema,
} from "../../packages/gateway-protocol/src/index.js";
import { createUsageFixture } from "../agents/test-helpers/usage-fixtures.js";
import type { AssistantHistoryMessage, AssistantMessage } from "../llm/types.js";
import {
  createWorkerTranscriptRuntime,
  toWorkerInferenceContext,
  type WorkerTranscriptClient,
} from "./embedded-agent-transcript.runtime.js";
import { toWorkerTranscriptMessage } from "./transcript-message.js";

function assistantWithReplay(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "saved answer" }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: createUsageFixture(1, 1, 2),
    stopReason: "stop",
    timestamp: 1,
  };
}

it.each([false, true])(
  "preserves historical cost availability across worker boundaries (priced=%s)",
  async (priced) => {
    const original = assistantWithReplay();
    const { cost, ...tokens } = original.usage;
    const message: AssistantHistoryMessage = {
      ...original,
      usage: priced ? { ...tokens, cost: { ...cost, totalOrigin: "provider-billed" } } : tokens,
    };
    const launch = toWorkerTranscriptMessage(message, "launch");
    expect(launch?.kind).toBe("complete");
    if (!launch || launch.kind !== "complete") {
      throw new Error("Expected launch history");
    }
    expect(Value.Check(WorkerTranscriptMessageSchema, launch.message)).toBe(true);
    expect(launch.message).toHaveProperty("usage", message.usage);
    const inference = toWorkerInferenceContext({ messages: [message] });
    if (inference.kind !== "complete") {
      throw new Error("Expected inference history");
    }
    expect(Value.Check(WorkerInferenceContextSchema, inference.context)).toBe(true);
    expect(inference.context.messages[0]).toHaveProperty("usage", message.usage);
    const commit = vi.fn<WorkerTranscriptClient["commit"]>(async () => {});
    const runtime = createWorkerTranscriptRuntime({ commit });
    runtime.onMessagePersisted(message);
    await runtime.withSessionWriteSettlement(() => undefined);
    expect(commit.mock.calls[0]?.[0][0]).toHaveProperty("usage", message.usage);
    expect(
      validateWorkerTranscriptCommitParams({
        runEpoch: 1,
        seq: 1,
        baseLeafId: null,
        messages: commit.mock.calls[0]?.[0],
      }),
    ).toBe(true);
    expect(validateWorkerInferenceTerminalOutcome({ type: "done", message })).toBe(priced);
    expect(
      validateWorkerInferenceTerminalOutcome({
        type: "error",
        reason: "provider-error",
        message: "failed",
        usage: message.usage,
      }),
    ).toBe(priced);
    expect(message.usage).toEqual(
      priced ? { ...tokens, cost: { ...cost, totalOrigin: "provider-billed" } } : tokens,
    );
  },
);
