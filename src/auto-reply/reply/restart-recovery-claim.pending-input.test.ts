import path from "node:path";
import { assert, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../../agents/test-helpers/assistant-message-fixtures.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import { withCurrentUserTurnInput } from "../../sessions/user-turn-transcript-runtime-context.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRecoveryControllerFixture } from "./recovery-controller.fixture.test-support.js";

it.each(["internal_system", "external_user"] as const)(
  "keeps %s input admission semantics while a completion owns the lane",
  (kind) =>
    withOpenClawTestState({ label: "pending-event-admission" }, async (state) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:pending-event-admission",
        sessionId: "pending-event-admission",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await using actor = await createRecoveryControllerFixture(
        target,
        { sessionId: target.sessionId, updatedAt: 1 },
        {},
        upsertSessionEntryCore,
      );
      const provenance = { kind, ...(kind === "internal_system" ? { sourceTool: "restart" } : {}) };
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "Resume the pending event", idempotencyKey: "event-input", provenance },
        target: { ...target, sessionEntry: actor.entry, config: {} },
      });
      await recorder.stageApproved!({ runId: "event-run", assertCurrent: () => {} });
      const controller = actor.controller({
        inputProvenance: provenance,
        admissionRunId: "event-run",
        executionRunId: "event-run",
      });
      const releaseCompletion = createDeferred();
      const lane = "session:" + target.sessionKey;
      let completion: Promise<unknown> | undefined;
      let replay: Promise<unknown> | undefined;
      try {
        await expect(controller.admitUserTurn(recorder)).resolves.toBe("admitted");
        if (kind === "external_user") {
          expect(recorder.hasPersisted()).toBe(true);
          return;
        }
        completion = enqueueCommandInLane(lane, async () => {
          await releaseCompletion.promise;
          const manager = await SessionManager.openAsync(target, state.workspaceDir);
          const completionInput: PersistedUserTurnMessage = {
            role: "user",
            content: "Earlier worker completed",
            timestamp: 2,
            provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          };
          await manager.appendMessageAsync(completionInput);
          await manager.appendMessageAsync(
            makeAssistantMessageFixture({
              content: [{ type: "text", text: "Completion acknowledged" }],
              stopReason: "stop",
              errorMessage: undefined,
            }),
          );
        });
        replay = enqueueCommandInLane(lane, () =>
          withCurrentUserTurnInput(recorder, async () => {
            const manager = await SessionManager.openAsync(target, state.workspaceDir);
            const message = await recorder.resolveMessage();
            assert(message, "Missing staged event input");
            await manager.appendMessageAsync(message);
            expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
              role: "user",
              idempotencyKey: "event-input",
              content: "Resume the pending event",
            });
          }),
        );
        releaseCompletion.resolve();
        await Promise.all([completion, replay]);
        expect(recorder.isPendingInputConsumed?.()).toBe(true);
      } finally {
        releaseCompletion.resolve();
        await Promise.allSettled([completion, replay]);
        recorder.finishPendingInput!("interrupted");
        await recorder.waitForPendingInputSettlement!();
        await controller.clear();
      }
    }),
);
