import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import type { PendingSessionShellCalls } from "./session-restart-resume-scope.js";
import { sessionEntryCommitGuardOptions } from "./session-source-authority.js";
import { buildSessionTranscriptTurnExpectedState } from "./session-transcript-turn-state.js";
import type { DeferredShellOutcome } from "./transcript-shell-receipt.js";
import { shellCallReceipt } from "./transcript-shell-receipt.js";
import type { SessionTranscriptWriteTarget } from "./transcript-write-context-store.js";
import {
  captureOwnedTranscriptWriteAssertion,
  getOwnedSessionTranscriptInitialWriter,
  getOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

export async function admitSessionShellCall(params: {
  target: SessionTranscriptWriteTarget & {
    sessionId: string;
    agentId: string;
    sessionKey: string;
    storePath: string;
  };
  fallbackFence?: SessionTranscriptWriteTarget;
  runId: string;
  callId: string;
  captureNotice: () => Promise<PendingSessionShellCalls["notice"]>;
}) {
  const { target, runId, callId, fallbackFence, captureNotice } = params;
  const owner = { sessionKey: target.sessionKey, sessionTarget: target };
  const initial = getOwnedSessionTranscriptInitialWriter(owner);
  const fence = initial
    ? initial.committedFence
    : (getOwnedSessionTranscriptWriterFence(owner) ?? fallbackFence);
  const writer = fence?.expectedWriterRunId;
  if (!writer) {
    throw new Error(
      "The shell command was not started because its session writer could not be verified.",
    );
  }
  const receipt = shellCallReceipt(runId, callId);
  const assertCurrent = captureOwnedTranscriptWriteAssertion(target);
  const expected = {
    sessionId: target.sessionId,
    lifecycleRevision: fence.expectedLifecycleRevision,
    activeWriterRunId: writer,
  };
  const row = await applySessionEntryOperation(
    target,
    {
      kind: "shell-call",
      runId,
      call: { callId, key: receipt.key },
      notice: await captureNotice(),
      expected,
    },
    {
      ...sessionEntryCommitGuardOptions(assertCurrent),
      preserveActivity: true,
      skipMaintenance: true,
      requireWriteSuccess: true,
    },
  );
  assertCurrent();
  if (
    row?.sessionId !== expected.sessionId ||
    row.lifecycleRevision !== expected.lifecycleRevision ||
    row.activeWriterRunId !== writer ||
    row.pendingShellCalls?.runId !== runId ||
    !row.pendingShellCalls.calls.some((call) => call.key === receipt.key)
  ) {
    throw new Error(
      "The shell command was not started because its restart receipt could not be saved.",
    );
  }
  // The detached approval owner outlives the tool call. Its private capability can
  // append one terminal observation only while this incarnation still holds that receipt.
  let observationKey: string | undefined;
  return {
    ...receipt,
    recordDeferredOutcome: async (outcome: DeferredShellOutcome) => {
      try {
        const current = await readSessionEntryReadOnlyInWorker(target);
        if (
          !current?.pendingShellCalls ||
          current.pendingShellCalls.runId !== runId ||
          !current.pendingShellCalls.calls.some((call) => call.key === receipt.key)
        ) {
          return;
        }
        const { persistSessionTranscriptTurn } = await import("./session-accessor.js");
        observationKey ??= `${receipt.key}/${randomUUID()}`;
        await persistSessionTranscriptTurn(target, {
          runId,
          expectedSessionId: target.sessionId,
          expectedLifecycleRevision: expected.lifecycleRevision ?? null,
          expectedSessionState: {
            ...buildSessionTranscriptTurnExpectedState(current),
            pendingShellCall: { runId, key: receipt.key },
          },
          touchSessionEntry: false,
          updateMode: "none",
          messages: [
            {
              message: {
                role: "custom",
                customType: "openclaw:shell-approval-outcome",
                display: false,
                content:
                  outcome.kind === "exited"
                    ? `The shell command exited with code ${outcome.exitCode}.`
                    : "The shell command did not start.",
                details: { toolCallId: callId, ...outcome },
                timestamp: Date.now(),
                idempotencyKey: observationKey,
              },
            },
          ],
        });
      } catch (error) {
        // Follow-up delivery remains independent. Without an accepted observation, recovery pauses.
        createSubsystemLogger("agents/exec-approval").warn(
          `Could not record the deferred shell outcome: ${String(error)}`,
        );
      }
    },
  };
}
