import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { lookupSessionGoalOperation } from "../../config/sessions/goals-operations-read.js";
import {
  mutateSessionGoal,
  type SessionGoalOperation,
} from "../../config/sessions/goals-operations.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.transcript-turn.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s Goal receipt workers",
  (engine) => {
    useMixedAgentPair(engine, engine);
    it("reads absent receipts, then persists start and management receipts through workers", async () => {
      const sessionId = "goal-receipt";
      const { path: storePath } = withEngineStoreAdmission(() =>
        openOpenClawAgentDatabase({ agentId: "main" }),
      );
      const scope = {
        agentId: "main",
        sessionKey: `agent:main:${sessionId}`,
        sessionId,
        storePath,
      };
      const request = <Operation extends SessionGoalOperation>(operation: Operation) => ({
        ...scope,
        expectedSessionId: scope.sessionId,
        operation,
      });
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
      const start = {
        operationId: "start",
        requestFingerprint: "start",
        issuedAtMs: Date.now(),
        action: "start",
        objective: "Preserve the café migration 🦞",
      } as const;
      await expect(lookupSessionGoalOperation(request(start))).resolves.toBeUndefined();
      const turn = await persistSessionTranscriptTurn(scope, {
        expectedSessionId: scope.sessionId,
        updateMode: "none",
        runId: "goal-run",
        messages: [
          {
            message: { role: "user", content: start.objective, idempotencyKey: start.operationId },
          },
        ],
        sessionTurnMutation: { kind: "goal", operation: start, runId: "goal-run" },
      });
      const started = turn.sessionTurnMutationResult;
      assert(started);
      expect(started.result).toMatchObject({
        status: "started",
        goal: { objective: start.objective, status: "active" },
      });
      await expect(lookupSessionGoalOperation(request(start))).resolves.toEqual(started.result);

      const pause = {
        operationId: "pause",
        requestFingerprint: "pause",
        issuedAtMs: Date.now(),
        action: "pause",
        goalId: started.result.goalId,
      } as const;
      const paused = await mutateSessionGoal(request(pause));
      expect(paused.result).toMatchObject({
        status: "updated",
        goal: { id: started.result.goalId, status: "paused" },
      });
      await expect(lookupSessionGoalOperation(request(pause))).resolves.toEqual(paused.result);
    });
  },
);
