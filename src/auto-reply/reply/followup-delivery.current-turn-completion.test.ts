import { describe, expect, it, vi } from "vitest";
import { copyCurrentTurnReplyCompletion } from "../../agents/current-turn-reply-completion.js";
import { createSourceReplyReceiptFixture } from "../../agents/current-turn-reply-completion.test-support.js";
import { resolveFollowupDeliveryDecision } from "./followup-delivery.js";
import { createFollowupTurnTestTurn } from "./followup-turn-execution.test-support.js";

vi.mock("../../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../channels/plugins/index.js")>()),
  getChannelPlugin: () => undefined,
}));

describe("rejected followup source completion", () => {
  it.each(["sent", "partial_failed", "forged"] as const)(
    "suppresses a rejected followup only with authenticated %s completion",
    async (status) => {
      const receipt = await createSourceReplyReceiptFixture(status, {
        runId: "run-1",
        sessionId: "session",
        provider: "openai",
        model: "model",
      });
      const execution = copyCurrentTurnReplyCompletion(receipt, {
        runId: "run-1",
        outcome: {
          kind: "rejected" as const,
          payload: { text: "visible failure", isError: true },
        },
      });
      const original = structuredClone(execution);
      const decision = resolveFollowupDeliveryDecision({
        turn: createFollowupTurnTestTurn(),
        execution,
      });
      expect(decision).toMatchObject(
        status === "forged"
          ? { kind: "deliver", payloads: [{ text: "visible failure", isError: true }] }
          : { kind: "suppress", reason: "message-tool-only" },
      );
      expect(execution).toEqual(original);
    },
  );
});
