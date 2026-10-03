import {
  closeAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import {
  classifyAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import { hasCurrentAcpSourceTurn } from "../config/sessions/acp-source-turn-state.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { CapturedSessionEntryReadSource } from "../config/sessions/session-entry-read-source.types.js";
import type { TranscriptTurnAdmission } from "../config/sessions/transcript-entry-anchor.js";
import { readTranscriptEntryProvenance } from "../config/sessions/transcript-entry-provenance.js";
import { hasLiveAgentRunContext } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../infra/sqlite-worker-identity.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { restrictUserTurnTranscriptSourceDatabase } from "./user-turn-transcript-admission.js";
import type { UserTurnTranscriptRecorder } from "./user-turn-transcript.types.js";

const log = createSubsystemLogger("sessions/acp");

export type AcpSourceTurnInputIdentity = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | undefined;
  database?: { path: string; identity: DatabaseFileIdentity };
};

export function captureAcpSourceTurnDatabaseIdentity(
  selectedStore?: { path: string },
  readSource?: CapturedSessionEntryReadSource,
) {
  // The read owner has already resolved this alias to an admitted SQLite source.
  // Incognito retains its existing process-held namespace rather than a file owner.
  if (!selectedStore) {
    return undefined;
  }
  if (typeof readSource?.databaseIdentity !== "string") {
    throw new Error("ACP source input requires its original database read identity.");
  }
  return {
    path: selectedStore.path,
    identity: {
      key: `file:${readSource.databaseIdentity}`,
      birthtime: readSource.databaseBirthtime,
    },
  };
}

/** File aliases must still name the original physical source throughout the turn. */
export function assertAcpSourceTurnDatabaseCurrent(
  source: AcpSourceTurnInputIdentity | undefined,
  receipt?: Pick<TranscriptTurnAdmission, "storePath">,
): void {
  const database = source?.database;
  if (!database) {
    return;
  }
  for (const pathname of receipt ? [database.path, receipt.storePath] : [database.path]) {
    const current = readDatabasePathIdentitySync(pathname);
    if (
      current.key !== database.identity.key ||
      current.birthtime !== database.identity.birthtime
    ) {
      throw new Error("ACP input admission must retain the original physical source database.");
    }
  }
}

export async function prepareAcpSourceTurnInput(
  recorder: UserTurnTranscriptRecorder | undefined,
  target: { agentId: string; sessionKey: string; entry?: { sessionId: string } },
  runId: string,
  assertCallerCurrent: () => void,
  assertRouteCurrent: () => Promise<void>,
  sourceInput?: {
    identity?: AcpSourceTurnInputIdentity;
    onSourceCaptured?: (identity: AcpSourceTurnInputIdentity) => void;
  },
): Promise<void> {
  let expectedSource = sourceInput?.identity;
  const assertCurrent = () => {
    assertCallerCurrent();
    assertAcpSourceTurnDatabaseCurrent(expectedSource, recorder?.getAdmissionReceipt());
  };
  if (!recorder) {
    await assertRouteCurrent();
    return;
  }
  assertCurrent();
  if (expectedSource?.database && !recorder.hasPersisted()) {
    restrictUserTurnTranscriptSourceDatabase(recorder, expectedSource.database.identity);
  }
  const persisted = await recorder.persistApproved(
    expectedSource
      ? {
          expectedSessionId: expectedSource.sessionId,
          expectedLifecycleRevision: expectedSource.lifecycleRevision ?? null,
        }
      : undefined,
  );
  await recorder.waitForRuntimePersistence();
  assertCurrent();
  if (!recorder.hasPersisted()) {
    throw new Error("ACP input must be durably committed before dispatch.");
  }
  const source = recorder.getAdmissionReceipt();
  if (expectedSource && !source) {
    throw new Error(
      "ACP canonical source input requires a durable admission receipt before dispatch.",
    );
  }
  const provenance = source ? readTranscriptEntryProvenance(source) : undefined;
  if (source && provenance) {
    const originalSource: AcpSourceTurnInputIdentity = {
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      sessionId: provenance.canonicalSource?.sessionId ?? source.sessionId,
      lifecycleRevision: provenance.canonicalSource?.lifecycleRevision,
      database: provenance.database,
    };
    sourceInput?.onSourceCaptured?.(originalSource);
    assertAcpSourceTurnDatabaseCurrent(originalSource, source);
    if (
      expectedSource &&
      (!provenance.canonicalSource ||
        expectedSource.agentId !== originalSource.agentId ||
        expectedSource.sessionKey !== originalSource.sessionKey ||
        expectedSource.sessionId !== originalSource.sessionId ||
        expectedSource.lifecycleRevision !== originalSource.lifecycleRevision ||
        expectedSource.database?.identity.key !== originalSource.database?.identity.key ||
        expectedSource.database?.identity.birthtime !== originalSource.database?.identity.birthtime)
    ) {
      throw new Error(
        "ACP input must retain the source admitted by its original transcript owner.",
      );
    }
    if (provenance.canonicalSource && originalSource.sessionId !== source.sessionId) {
      throw new Error("ACP input receipt changed its original source identity.");
    }
    // An attested rowless original cannot acquire a later canonical execution owner.
    if (!provenance.canonicalSource) {
      await assertRouteCurrent();
      assertCurrent();
      return;
    }
    expectedSource = originalSource;
  }
  await assertRouteCurrent();
  if (source) {
    // Runtime persistence can issue an admission without a new recorder write result.
    const committedEntry = persisted?.sessionEntry;
    let entry = committedEntry;
    if (!entry || !expectedSource) {
      entry = await withSessionEntryReadOnlyInWorker(
        { ...source, readConsistency: "latest" },
        assertCurrent,
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          return read.value;
        },
      );
    }
    if (!entry) {
      // A successful transcript-only recorder has no canonical execution owner to claim.
      if (!expectedSource) {
        await assertRouteCurrent();
        assertCurrent();
        return;
      }
      throw new Error("ACP source session identity is required before dispatch.");
    }
    if (!provenance || !expectedSource) {
      throw new Error("ACP canonical input requires its original source admission facts.");
    }
    if (
      entry.sessionId !== source.sessionId ||
      (expectedSource &&
        (source.agentId !== expectedSource.agentId ||
          source.sessionKey !== expectedSource.sessionKey ||
          source.sessionId !== expectedSource.sessionId ||
          entry.lifecycleRevision !== expectedSource.lifecycleRevision))
    ) {
      throw new Error("ACP source changed before input admission completed.");
    }
    await claimAcpSourceTurn({
      source,
      runId,
      expectedLifecycleRevision: expectedSource
        ? expectedSource.lifecycleRevision
        : entry.lifecycleRevision,
      targetAgentId: target.agentId,
      targetSessionKey: target.sessionKey,
      targetSessionId: target.entry?.sessionId ?? null,
      assertCurrent,
    });
    await assertRouteCurrent();
    assertCurrent();
  }
}

/** Commit before submitting input to ACP, while the source admission still owns the turn. */
async function claimAcpSourceTurn(params: {
  source: TranscriptTurnAdmission;
  runId: string;
  expectedLifecycleRevision: string | undefined;
  targetAgentId: string;
  targetSessionKey: string;
  targetSessionId: string | null;
  assertCurrent: () => void;
}): Promise<void> {
  let incumbentRunIds: string[] = [];
  const assertClaimCurrent = () => {
    params.assertCurrent();
    if (incumbentRunIds.some((runId) => hasLiveAgentRunContext(runId))) {
      throw new Error("Another live run still owns the ACP source.");
    }
  };
  const committed = await patchSessionEntryCore(
    params.source,
    (entry) => {
      incumbentRunIds = [entry.activeWriterRunId, entry.lifecycleRunId].filter(
        (runId): runId is string => runId !== undefined && runId !== params.runId,
      );
      assertClaimCurrent();
      if (
        entry.sessionId !== params.source.sessionId ||
        entry.lifecycleRevision !== params.expectedLifecycleRevision
      ) {
        throw new Error("ACP source changed before execution ownership was committed.");
      }
      return {
        acpSourceTurn: {
          sourceSessionId: entry.sessionId,
          sourceLifecycleRevision: entry.lifecycleRevision,
          runId: params.runId,
          targetAgentId: params.targetAgentId,
          targetSessionKey: params.targetSessionKey,
          targetSessionId: params.targetSessionId,
        },
        activeWriterRunId: params.runId,
        lifecycleRunId: params.runId,
        lastRunId: undefined,
        lastRunError: undefined,
        startedAt: Date.now(),
        endedAt: undefined,
        runtimeMs: undefined,
        status: "running",
        abortedLastRun: false,
      };
    },
    {
      skipMaintenance: true,
      requireWriteSuccess: true,
      workerGuard: { assertCurrent: assertClaimCurrent },
    },
  );
  if (committed?.acpSourceTurn?.runId !== params.runId) {
    throw new Error("ACP source execution ownership was not persisted.");
  }
}

/** ACP target lifecycle events cannot substitute for settlement of the admitted source. */
async function settleAcpSourceTurn(params: {
  source: TranscriptTurnAdmission;
  runId: string;
  outcome: AgentRunTerminalOutcome;
  assertCurrent?: () => void;
}): Promise<void> {
  // Restart cancellation leaves the source for the new process's interruption notice.
  if (params.outcome.reason === "cancelled" && params.outcome.stopReason === "restart") {
    return;
  }
  const status = {
    success: "done",
    failure: "failed",
    cancellation: "killed",
    timeout: "timeout",
  } as const;
  const endedAt = params.outcome.endedAt ?? Date.now();
  await patchSessionEntryCore(
    params.source,
    (entry) => {
      if (
        entry.sessionId !== params.source.sessionId ||
        !hasCurrentAcpSourceTurn(entry) ||
        entry.acpSourceTurn?.runId !== params.runId ||
        entry.activeWriterRunId !== params.runId
      ) {
        return null;
      }
      return {
        acpSourceTurn: undefined,
        activeWriterRunId: undefined,
        abortedLastRun: false,
        endedAt,
        lastRunId: params.runId,
        lastRunError: params.outcome.error,
        lifecycleRunId: undefined,
        status: status[classifyAgentRunTerminalOutcome(params.outcome)],
        runtimeMs: Math.max(0, endedAt - (entry.startedAt ?? endedAt)),
      };
    },
    {
      skipMaintenance: true,
      requireWriteSuccess: true,
      workerGuard: { assertCurrent: params.assertCurrent },
    },
  );
}

export async function finishAcpSourceTurn(
  recorder: UserTurnTranscriptRecorder | undefined,
  runId: string,
  outcome: AgentRunTerminalOutcome | undefined,
  admittedRunContext: AdmittedRunContext | undefined,
  assertSourceDatabaseCurrent?: () => void,
): Promise<void> {
  let source: TranscriptTurnAdmission | undefined;
  try {
    source = recorder?.getAdmissionReceipt();
    if (source && outcome) {
      const assertAdmittedCurrent = admittedRunContext
        ? resolveAdmittedRunActiveAssertion(admittedRunContext)
        : undefined;
      if (admittedRunContext && !assertAdmittedCurrent) {
        throw new Error("ACP source settlement admission is no longer active.");
      }
      const assertCurrent = () => {
        assertAdmittedCurrent?.();
        assertSourceDatabaseCurrent?.();
      };
      assertCurrent();
      await settleAcpSourceTurn({ source, runId, outcome, assertCurrent });
    }
  } catch (error) {
    // Cleanup cannot reopen consumed input after ACP execution or reply delivery.
    // An uncommitted source fact remains recoverable; uncertain commits are logged.
    log.warn("ACP source settlement failed after dispatch", {
      runId,
      sourceSessionKey: source?.sessionKey,
      error: formatErrorMessage(error),
    });
  } finally {
    if (admittedRunContext) {
      closeAdmittedRunDelegatedAuthority(admittedRunContext);
    }
  }
}
