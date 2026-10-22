import assert from "node:assert/strict";
import { beforeEach, describe, expect, it } from "vitest";
import { lookupSessionGoalOperation } from "../../config/sessions/goals-operations-read.js";
import { mutateSessionGoal } from "../../config/sessions/goals-operations.js";
import type { SessionAccessScope } from "../../config/sessions/session-accessor.sqlite-contract.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { persistSessionTranscriptTurn } from "../../config/sessions/session-accessor.transcript-turn.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s Goal receipt workers",
  (engine) => {
    useMixedAgentPair(engine, engine);
    let sequence = 0;
    let scope: SessionAccessScope & { sessionId: string };
    beforeEach(async () => {
      const sessionId = `goal-receipt-${++sequence}`;
      const { path: storePath } = withEngineStoreAdmission(() =>
        openOpenClawAgentDatabase({ agentId: "main" }),
      );
      scope = { agentId: "main", sessionKey: `agent:main:${sessionId}`, sessionId, storePath };
      await upsertSessionEntryCore(scope, { sessionId, updatedAt: Date.now() });
    });

    it("reads an absent Goal receipt through the history worker", async () => {
      await expect(
        lookupSessionGoalOperation({
          ...scope,
          expectedSessionId: scope.sessionId,
          operation: {
            operationId: "absent",
            requestFingerprint: "absent",
            issuedAtMs: Date.now(),
            action: "clear",
            goalId: "absent-goal",
          },
        }),
      ).resolves.toBeUndefined();
    });

    it("persists Goal start and management receipts through their production workers", async () => {
      const start = {
        operationId: "start",
        requestFingerprint: "start",
        issuedAtMs: Date.now(),
        action: "start",
        objective: "Preserve the café migration 🦞",
      } as const;
      const turn = await persistSessionTranscriptTurn(scope, {
        expectedSessionId: scope.sessionId,
        updateMode: "none",
        runId: "goal-run",
        messages: [
          {
            message: {
              role: "user",
              content: start.objective,
              idempotencyKey: start.operationId,
            },
          },
        ],
        sessionTurnMutation: { kind: "goal", operation: start, runId: "goal-run" },
      });
      const started = turn.sessionTurnMutationResult;
      assert(started);
      expect(started).toMatchObject({
        replayed: false,
        result: {
          action: "start",
          operationId: "start",
          sessionId: scope.sessionId,
          status: "started",
          runId: "goal-run",
          goal: { objective: start.objective, status: "active" },
        },
      });
      await expect(
        lookupSessionGoalOperation({
          ...scope,
          expectedSessionId: scope.sessionId,
          operation: start,
        }),
      ).resolves.toEqual(started.result);

      const pause = {
        operationId: "pause",
        requestFingerprint: "pause",
        issuedAtMs: Date.now(),
        action: "pause",
        goalId: started.result.goalId,
      } as const;
      const paused = await mutateSessionGoal({
        ...scope,
        expectedSessionId: scope.sessionId,
        operation: pause,
      });
      expect(paused).toMatchObject({
        replayed: false,
        result: {
          action: "pause",
          operationId: "pause",
          status: "updated",
          goal: { id: started.result.goalId, status: "paused" },
        },
      });
      await expect(
        lookupSessionGoalOperation({
          ...scope,
          expectedSessionId: scope.sessionId,
          operation: pause,
        }),
      ).resolves.toEqual(paused.result);
    });
  },
);
