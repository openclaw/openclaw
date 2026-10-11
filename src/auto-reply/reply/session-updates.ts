import crypto from "node:crypto";
import {
  type ExecPolicyOverrides,
  prepareExecDefaults,
  resolveNodeExecEligibility,
  resolvePreparedExecDefaultsAsync,
} from "../../agents/exec-defaults.js";
import { withSandboxRuntimeStatusInWorker } from "../../agents/sandbox/runtime-status.js";
import type { SessionEntry } from "../../config/sessions.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { projectCompactionAccountingPatch } from "../../config/sessions/session-entry-projection.js";
import type { SessionEntryCohortReader } from "../../config/sessions/session-entry-read-runtime.types.js";
import {
  sessionEntryCommitGuardOptions,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { captureSessionTranscriptStorageEnvironment } from "../../config/sessions/transcript-target-binding.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isFastTestRuntimeEnv } from "../../infra/env.js";
import { loadExecApprovalsReadOnlyAsync } from "../../infra/exec-approvals-store.js";
import { resolveSessionSkillExecutionWorkspace } from "../../skills/loading/workspace-skill-roots.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import { publishReplySessionEntry, type ReplySessionEntryHandle } from "./session-entry-handle.js";

async function persistSkillSnapshot(params: {
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  currentEntry: SessionEntry;
  skillsSnapshot: SessionEntry["skillsSnapshot"];
  isFirstTurnInSession: boolean;
  assertCurrent?: SessionSourceAssertion;
}): Promise<SessionEntry | undefined> {
  params.assertCurrent?.();
  const updates = {
    updatedAt: Date.now(),
    ...(params.isFirstTurnInSession ? { systemSent: true } : {}),
    skillsSnapshot: params.skillsSnapshot,
  };
  if (!params.storePath) {
    const current = params.sessionEntryHandle
      ? params.sessionEntryHandle.get(params.sessionKey)
      : params.sessionStore?.[params.sessionKey];
    // Preparation can yield to session management. Apply only the owned fields
    // to its current row, including field removals such as unpinning.
    const nextEntry = { ...(current ?? params.currentEntry), ...updates };
    publishReplySessionEntry(params, nextEntry);
    return nextEntry;
  }
  const persistedEntry = await patchSessionEntryCore(
    {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    () => {
      params.assertCurrent?.();
      return updates;
    },
    sessionEntryCommitGuardOptions(params.assertCurrent),
  );
  params.assertCurrent?.();
  publishReplySessionEntry(params, persistedEntry ?? undefined);
  return persistedEntry ?? undefined;
}

function readSkillSnapshotState(entry: SessionEntry | undefined) {
  return {
    sessionEntry: entry,
    skillsSnapshot: entry?.skillsSnapshot,
    systemSent: entry?.systemSent ?? false,
  };
}

export async function ensureSkillSnapshot(params: {
  agentId: string;
  reader?: SessionEntryCohortReader;
  sessionEntry?: SessionEntry;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  sessionId?: string;
  isFirstTurnInSession: boolean;
  workspaceDir: string;
  executionWorkspaceDir?: string;
  cfg: OpenClawConfig;
  execOverrides?: ExecPolicyOverrides;
  /** If provided, only load skills with these names (for per-channel skill filtering) */
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  assertCurrent?: SessionSourceAssertion;
}): Promise<{
  sessionEntry?: SessionEntry;
  skillsSnapshot?: SessionEntry["skillsSnapshot"];
  systemSent: boolean;
}> {
  if (isFastTestRuntimeEnv()) {
    // In fast unit-test runs we skip filesystem scanning, watchers, and session-store writes.
    // Dedicated skills tests cover snapshot generation behavior.
    return readSkillSnapshotState(params.sessionEntry);
  }

  const {
    agentId,
    sessionEntry,
    sessionEntryHandle,
    sessionStore,
    sessionKey,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter,
    skillOverrides,
  } = params;
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const cwd = process.cwd();
  const assertCurrent = () => {
    params.assertCurrent?.();
    params.reader?.assertCurrent();
  };
  assertCurrent();

  // Prepare this turn's cache once. A simultaneous reset can refresh it on the
  // next turn; only the owned cache fields are persisted below.
  let nextEntry = sessionEntryHandle?.getCurrent() ?? sessionEntry;
  const execParams = {
    cfg,
    sessionEntry,
    sessionKey,
    agentId,
    execOverrides: params.execOverrides,
  };
  const existingSnapshot = nextEntry?.skillsSnapshot;
  const snapshotState = await withSandboxRuntimeStatusInWorker(
    execParams,
    { env, cwd, assertCurrent, reader: params.reader },
    async (sandbox) => {
      const execDefaults = await resolvePreparedExecDefaultsAsync(
        prepareExecDefaults(execParams, sandbox),
        () => loadExecApprovalsReadOnlyAsync({ env }),
      );
      assertCurrent();
      const nodeSkillsEligibility = resolveNodeExecEligibility(execParams, execDefaults);
      const result = await resolveReusableWorkspaceSkillSnapshot({
        assertCurrent,
        workspaceDir,
        ...resolveSessionSkillExecutionWorkspace(
          nextEntry?.worktree?.canonicalWorkspaceDir,
          params.executionWorkspaceDir,
        ),
        config: cfg,
        agentId,
        skillFilter,
        skillOverrides,
        resolveEligibility: () => ({
          nodeSkills: nodeSkillsEligibility,
          remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkillsEligibility.canExec }),
        }),
        existingSnapshot,
        librarySelections: nextEntry?.skillLibrarySelections,
      });
      assertCurrent();
      return result;
    },
  );
  const skillsSnapshot = snapshotState.snapshot;
  if (
    (sessionEntryHandle || sessionStore) &&
    sessionKey &&
    (isFirstTurnInSession || !existingSnapshot || snapshotState.shouldRefresh)
  ) {
    nextEntry = await persistSkillSnapshot({
      ...params,
      sessionKey,
      currentEntry: nextEntry ?? {
        sessionId: sessionId ?? crypto.randomUUID(),
        updatedAt: Date.now(),
      },
      skillsSnapshot,
    });
    if (!nextEntry) {
      return readSkillSnapshotState(undefined);
    }
  }

  if (sessionKey && (sessionEntryHandle || sessionStore)) {
    nextEntry = sessionEntryHandle ? sessionEntryHandle.getCurrent() : sessionStore?.[sessionKey];
  }
  return { sessionEntry: nextEntry, skillsSnapshot, systemSent: nextEntry?.systemSent ?? false };
}

/** Accounts completed compaction without creating or changing session ownership. */
export async function incrementCompactionCount(
  params: Parameters<typeof projectCompactionAccountingPatch>[1] & {
    agentId?: string;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath: string;
    expectedSession?: Pick<
      InternalSessionEntry,
      "sessionId" | "lifecycleRevision" | "activeWriterRunId"
    >;
    authorize?: () => boolean;
  },
): Promise<number | undefined> {
  const { sessionStore, sessionKey, storePath, authorize } = params;
  if (!sessionKey || !storePath) {
    return undefined;
  }
  const cachedEntry = sessionStore?.[sessionKey] ?? params.sessionEntry;
  const initial: typeof params.expectedSession = params.expectedSession ?? cachedEntry;
  if (!initial) {
    return undefined;
  }
  const expected = {
    sessionId: initial.sessionId,
    lifecycleRevision: initial.lifecycleRevision,
    activeWriterRunId: initial.activeWriterRunId,
  };
  let committed = false;
  const authorityRevoked = new Error("compaction accounting authority revoked");
  try {
    const persisted = await applySessionEntryOperation(
      { agentId: params.agentId, storePath, sessionKey },
      {
        kind: "compaction-accounting",
        expected,
        accounting: {
          amount: params.amount,
          compactionKind: params.compactionKind,
          now: params.now,
          tokensAfter: params.tokensAfter,
          transcriptByteCompactionLatch: params.transcriptByteCompactionLatch,
        },
      },
      {
        onCommitted: (entry) => {
          committed = true;
          // Publish while this commit owns the row, before maintenance yields to a new writer.
          if (sessionStore) {
            sessionStore[sessionKey] = entry;
          }
        },
        workerGuard: {
          assertCurrent: authorize
            ? () => {
                if (!authorize()) {
                  throw authorityRevoked;
                }
              }
            : undefined,
        },
      },
    );
    return committed ? persisted?.compactionCount : undefined;
  } catch (error) {
    if (error === authorityRevoked) {
      return undefined;
    }
    throw error;
  }
}
