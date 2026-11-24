import assert from "node:assert/strict";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { withSessionState } from "../../agents/sessions/session-manager-fixtures.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { DecisionBatch } from "../../decisions/types.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-input.types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { prepareGroupParticipation } from "./group-participation.js";
import { createPreparationRun } from "./reply-agent-turn-preparation.test-support.js";

const evaluate = vi.hoisted(() =>
  vi.fn<typeof import("../../decisions/runtime.js").evaluateDecision>(),
);
vi.mock("../../decisions/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../decisions/runtime.js")>()),
  evaluateDecision: evaluate,
}));

it("budgets rendered user evidence while retaining tool receipts and the current-input cutoff", async () => {
  await withSessionState("participation-input", async ({ state, scope }) => {
    const manager = await SessionManager.openAsync(scope);
    const prior: PersistedUserTurnMessage = {
      role: "user",
      content: "Original user text",
      timestamp: 1,
      __openclaw: {
        upstreamUserText: "Storage-only native prompt. ".repeat(2000),
        modelPromptProjection: { version: 1, text: "Rendered group and user evidence" },
        senderId: "alice-42",
        senderName: "Alice",
      },
    };
    await manager.appendMessageAsync(prior);
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [
          {
            type: "toolCall",
            id: "delivered",
            name: "message",
            arguments: { action: "send", message: "The port is 443.", final: true },
          },
        ],
      }),
    );
    const receipt = {
      role: "toolResult" as const,
      toolCallId: "delivered",
      toolName: "message",
      timestamp: 2,
      content: [{ type: "text" as const, text: "Sent." }],
      isError: false,
      details: {
        messageDelivery: { status: "settled", partialDelivery: false, sourceReplyDelivered: true },
      },
    };
    await manager.appendMessageAsync(receipt);
    const config = {
      agents: {
        defaults: { decisionModel: "fixture/decision", experimental: { decisionAssistance: true } },
      },
    };
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "Current ping", idempotencyKey: "current:user" },
      target: { ...scope, config, cwd: state.workspaceDir, sessionEntry: undefined },
    });
    await recorder.persistApproved();
    await (
      await SessionManager.openAsync(scope)
    ).appendMessageAsync({
      role: "user",
      content: "Later input",
      timestamp: 4,
    });
    let prepared: DecisionBatch | undefined;
    evaluate.mockImplementationOnce(async (batch, options, prepareState) => {
      const result = await prepareState!(
        { maxStateAndQuestionTokens: 32000, maxRequestTokens: 64000 },
        options.signal,
      );
      if (result !== undefined) {
        prepared = { ...batch, state: result };
      }
      // Stop at the actual Decision input boundary; no primary-model response supplies the proof.
      return { status: "unavailable", reason: "unsupported-input" };
    });
    const operation = createReplyOperation({
      sessionKey: scope.sessionKey,
      sessionId: scope.sessionId,
      resetTriggered: false,
    });
    try {
      await prepareGroupParticipation({
        ...scope,
        operation,
        run: {
          ...createPreparationRun({
            prompt: "Current ping",
            run: { ...scope, config, workspaceDir: state.workspaceDir },
          }),
          groupParticipation: {},
          userTurnTranscriptRecorder: recorder,
        },
      });
    } finally {
      operation.complete();
    }
    assert(prepared && isRecord(prepared.state), "Expected prepared Decision state");
    expect(Buffer.byteLength(JSON.stringify(prepared))).toBeLessThanOrEqual(32000);
    const history = prepared.state.conversation;
    assert(typeof history === "string");
    expect(history).toContain("Rendered group and user evidence");
    expect(history).toContain("alice-42");
    expect(history).not.toContain("upstreamUserText");
    expect(history).not.toContain("Current ping");
    expect(history).not.toContain("Later input");
    expect(JSON.parse(history)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({ type: "toolCall", id: "delivered" }),
          ]),
        }),
        receipt,
      ]),
    );
  });
});
