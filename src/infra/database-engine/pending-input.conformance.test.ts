import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import {
  listSessionPendingInputs,
  readSessionPendingInput,
  readSessionSubmittedInput,
  stageSessionPendingInput,
  type SessionPendingInputReceipt,
} from "../../config/sessions/session-accessor.pending-inputs.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { appendTranscriptMessage } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionPendingInputContext } from "../../config/sessions/session-pending-input-history.js";
import { discardSessionPendingInput } from "../../config/sessions/session-pending-input-withdrawal.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s pending input workers",
  (engine) => {
    useMixedAgentPair(engine, engine);
    const receipts: SessionPendingInputReceipt[] = [];
    let sequence = 0;
    let scope: Parameters<typeof stageSessionPendingInput>[0];
    afterEach(async () => {
      const retained = receipts.splice(0);
      for (const receipt of retained) {
        receipt.finish("interrupted");
      }
      await Promise.all(retained.map(async (receipt) => receipt.settled?.()));
    });

    beforeEach(async () => {
      const sessionId = `pending-${++sequence}`;
      const { path: storePath } = withEngineStoreAdmission(() =>
        openOpenClawAgentDatabase({ agentId: "main" }),
      );
      scope = {
        agentId: "main",
        sessionKey: `agent:main:${sessionId}`,
        sessionId,
        storePath,
      };
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    });
    const stage = async (runId: string, trackCompletion = false) => {
      const idempotencyKey = `${runId}:user`;
      const receipt = await stageSessionPendingInput(scope, {
        runId,
        message: { role: "user", content: runId, timestamp: 1, idempotencyKey },
        trackCompletion,
        assertCurrent() {},
      });
      assert(receipt);
      receipts.push(receipt);
      return receipt;
    };

    it("retains interrupted history and excludes consumed inputs from counted and context pages", async () => {
      const retained = await stage("retained");
      retained.finish("interrupted");
      await retained.settled?.();
      const consumed = await stage("consumed");
      expect(
        await consumed.run(() => appendTranscriptMessage(scope, { message: consumed.message })),
      ).toMatchObject({ appended: true });
      expect(consumed.state).toBe("consumed");

      const expected = {
        id: retained.inputId,
        state: "interrupted",
        message: { content: "retained" },
      };
      expect(await listSessionPendingInputs(scope)).toMatchObject({ total: 1, items: [expected] });
      expect(await readSessionPendingInputContext(scope)).toMatchObject({ items: [expected] });
    });

    it("recovers submitted input from its retained pending row before transcript consumption", async () => {
      await stage("submitted");
      expect(await readSessionSubmittedInput(scope, "submitted:user")).toMatchObject({
        role: "user",
        content: "submitted",
        idempotencyKey: "submitted:user",
      });
    });

    it("returns a persisted completion when the same input is submitted again", async () => {
      const first = await stage("completed", true);
      assert(first.completeAsync);
      const outcome = buildAgentRunTerminalOutcome({ status: "ok" });
      expect(await first.completeAsync(outcome)).toEqual(outcome);
      first.finish("interrupted");
      await first.settled?.();

      const replay = await stage("completed", true);
      expect(replay).toMatchObject({ state: "consumed", completion: outcome });
      expect(() => replay.run(() => {})).toThrow("Input processing has already completed");
    });

    it("withdraws the selected queued input without changing its sibling", async () => {
      const removed = await stage("removed");
      const retained = await stage("sibling");
      expect(await discardSessionPendingInput(scope, "removed", () => {})).toBe(true);
      expect(await readSessionPendingInput(scope, removed.inputId)).toMatchObject({
        state: "cancelled",
        message: { display: false },
      });
      expect(await readSessionPendingInput(scope, retained.inputId)).toMatchObject({
        state: "queued",
        message: { content: "sibling" },
      });
    });
  },
);
