import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  captureSessionQueuedInputsForRestart,
  readSessionPendingInput,
} from "../config/sessions/session-pending-input-history.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { ensureGatewayOwnerProfile } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as gatewayDispatch from "./server-in-process-dispatch.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import { resumeMarkedSessions } from "./session-restart-resume.js";

it.for(["crash", "graceful-marker"] as const)(
  "settles A2A lifecycle and queued inputs without admitting new work (%s)",
  (mode) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const profile = ensureGatewayOwnerProfile("A2A task owner");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:a2a:default:direct:peer:ctx-proof",
        sessionId: "a2a-restart-proof",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      replaceSessionEntrySync(target, {
        sessionId: target.sessionId,
        updatedAt: 110,
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      const receipt = await stageSessionPendingInput(target, {
        runId: "queued-a2a-task",
        message: {
          role: "user",
          content: "Original queued A2A task",
          timestamp: 110,
          idempotencyKey: "queued-a2a-task:user",
          __openclaw: { senderIdentity: { type: "profile", id: profile.id } },
        },
        assertCurrent() {},
      });
      assert(receipt, "A2A input was not accepted");
      if (mode === "graceful-marker") {
        const captured = await captureSessionQueuedInputsForRestart(target);
        captured.preserve();
      }
      receipt.finish("interrupted");
      await receipt.settled?.();
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db
        .prepare(
          "UPDATE session_pending_inputs SET state = 'queued', lifecycle_generation = 'previous-process' WHERE input_id = ?",
        )
        .run(receipt.inputId);
      await persistGatewaySessionLifecycleEvent({
        sessionKey: target.sessionKey,
        event: {
          runId: "original-a2a-run",
          sessionId: target.sessionId,
          ts: 110,
          data: { phase: "start", startedAt: 110 },
        },
      });
      if (mode === "graceful-marker") {
        replaceSessionEntrySync(target, {
          ...loadExactSessionEntry(target)!.entry,
          resumeAfterRestart: { queuedInputIds: [receipt.inputId] },
        });
      }
      const resume = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
        accepted: Promise.resolve({ ok: true }),
        id: "unexpected-a2a-resume",
        settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
        cancel: () => false,
      });
      const dispatch = vi
        .spyOn(gatewayDispatch, "dispatchGatewayRequestInProcess")
        .mockResolvedValue({});
      try {
        await resumeMarkedSessions({
          context: {
            ...createContext([], () => cfg),
            restartResumeWindows: { main: [{ startedAt: 100, endedAt: 200 }] },
          },
          signal: new AbortController().signal,
          log: { warn() {} },
        });
        expect(resume).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(loadExactSessionEntry(target)?.entry).toMatchObject({
          status: "killed",
          lastRunId: "original-a2a-run",
        });
        expect(loadExactSessionEntry(target)?.entry.lifecycleRunId).toBeUndefined();
        expect(loadExactSessionEntry(target)?.entry.resumeAfterRestart).toBeUndefined();
        expect(await readSessionPendingInput(target, receipt.inputId)).toMatchObject({
          state: "cancelled",
          message: { content: "Original queued A2A task" },
        });
      } finally {
        resume.mockRestore();
        dispatch.mockRestore();
        receipt.finish("cancelled");
        await receipt.settled?.();
      }
    }),
);
