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
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
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
  expectedSession: Pick<SessionEntry, "sessionId" | "lifecycleRevision"> | undefined;
  sessionEntryHandle?: ReplySessionEntryHandle;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  currentEntry: SessionEntry;
  skillsSnapshot: SessionEntry["skillsSnapshot"];
  isFirstTurnInSession: boolean;
  assertCurrent?: SessionSourceAssertion;
}): Promise<{ entry: SessionEntry | undefined; updated: boolean }> {
  params.assertCurrent?.();
  const updates = {
    sessionId: params.sessionId ?? params.currentEntry.sessionId,
    updatedAt: Date.now(),
    ...(params.isFirstTurnInSession ? { systemSent: true } : {}),
    skillsSnapshot: params.skillsSnapshot,
  };
  if (!params.storePath) {
    const current = params.sessionEntryHandle
      ? params.sessionEntryHandle.get(params.sessionKey)
      : params.sessionStore?.[params.sessionKey];
    if (
      current?.sessionId !== params.expectedSession?.sessionId ||
      current?.lifecycleRevision !== params.expectedSession?.lifecycleRevision
    ) {
      return { entry: current, updated: false };
    }
    // Preparation can yield to session management. Apply only the owned fields
    // to its current row, including field removals such as unpinning.
    const nextEntry = { ...(current ?? params.currentEntry), ...updates };
    publishReplySessionEntry(params, nextEntry);
    return { entry: nextEntry, updated: true };
  }
  let updated = false;
  const persistedEntry = await patchSessionEntryCore(
    {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    (entry) => {
      params.assertCurrent?.();
      updated =
        entry.sessionId === params.expectedSession?.sessionId &&
        entry.lifecycleRevision === params.expectedSession?.lifecycleRevision;
      return updated ? updates : null;
    },
    sessionEntryCommitGuardOptions(params.assertCurrent),
  );
  params.assertCurrent?.();
  publishReplySessionEntry(params, persistedEntry ?? undefined);
  return { entry: persistedEntry ?? undefined, updated: Boolean(persistedEntry) && updated };
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
    storePath,
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

  let nextEntry = sessionEntryHandle?.getCurrent() ?? sessionEntry;
  const expectedSession = nextEntry && {
    sessionId: nextEntry.sessionId,
    lifecycleRevision: nextEntry.lifecycleRevision,
  };
  let systemSent = sessionEntry?.systemSent ?? false;
  const execParams = {
    cfg,
    sessionEntry,
    sessionKey,
    agentId,
    execOverrides: params.execOverrides,
  };
  const existingSnapshot = nextEntry?.skillsSnapshot;
  const resolveSnapshot = (
    snapshot: SessionEntry["skillsSnapshot"],
    prepareEntryConsumer?: (
      prepared: Awaited<ReturnType<typeof resolveReusableWorkspaceSkillSnapshot>>,
    ) => ((entry: SessionEntry | undefined) => void) | undefined,
  ) =>
    withSandboxRuntimeStatusInWorker(
      execParams,
      { env, cwd, assertCurrent, reader: params.reader, prepareEntryConsumer },
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
          existingSnapshot: snapshot,
          librarySelections: nextEntry?.skillLibrarySelections,
        });
        assertCurrent();
        return result;
      },
    );
  const persistSnapshot = (
    key: string,
    currentEntry: SessionEntry,
    skillsSnapshot: SessionEntry["skillsSnapshot"],
  ) =>
    persistSkillSnapshot({
      ...params,
      expectedSession,
      sessionKey: key,
      currentEntry,
      skillsSnapshot,
    });
  const createEntry = (): SessionEntry => ({
    sessionId: sessionId ?? crypto.randomUUID(),
    updatedAt: Date.now(),
  });
  let reusedSnapshot: ReturnType<typeof readSkillSnapshotState> | undefined;
  const initialSnapshotState = await resolveSnapshot(
    existingSnapshot,
    !isFirstTurnInSession &&
      existingSnapshot &&
      sessionKey &&
      storePath &&
      (sessionEntryHandle || sessionStore)
      ? (prepared) => {
          if (prepared.shouldRefresh) {
            return undefined;
          }
          return (entry) => {
            assertCurrent();
            publishReplySessionEntry(params, entry);
            reusedSnapshot = readSkillSnapshotState(entry);
            if (
              entry?.sessionId === expectedSession?.sessionId &&
              entry?.lifecycleRevision === expectedSession?.lifecycleRevision
            ) {
              reusedSnapshot.skillsSnapshot = prepared.snapshot;
            }
          };
        }
      : undefined,
  );
  if (reusedSnapshot) {
    assertCurrent();
    return reusedSnapshot;
  }
  const shouldRefreshSnapshot = initialSnapshotState.shouldRefresh;

  if (isFirstTurnInSession && (sessionEntryHandle || sessionStore) && sessionKey) {
    const current =
      nextEntry ??
      sessionEntryHandle?.get(sessionKey) ??
      sessionStore?.[sessionKey] ??
      createEntry();
    const skillSnapshot =
      !current.skillsSnapshot || shouldRefreshSnapshot
        ? initialSnapshotState.snapshot
        : (await resolveSnapshot(current.skillsSnapshot)).snapshot;
    const { entry, updated } = await persistSnapshot(sessionKey, current, skillSnapshot);
    if (!updated) {
      return readSkillSnapshotState(entry);
    }
    nextEntry = entry;
    systemSent = entry?.systemSent ?? systemSent;
  }

  const skillsSnapshot =
    nextEntry?.skillsSnapshot &&
    (nextEntry.skillsSnapshot !== existingSnapshot ||
      (isFirstTurnInSession && !shouldRefreshSnapshot))
      ? (await resolveSnapshot(nextEntry.skillsSnapshot)).snapshot
      : initialSnapshotState.snapshot;
  if (
    skillsSnapshot &&
    (sessionEntryHandle || sessionStore) &&
    sessionKey &&
    !isFirstTurnInSession &&
    (!nextEntry?.skillsSnapshot || shouldRefreshSnapshot)
  ) {
    const { entry, updated } = await persistSnapshot(
      sessionKey,
      nextEntry ?? createEntry(),
      skillsSnapshot,
    );
    if (!updated) {
      return readSkillSnapshotState(entry);
    }
    nextEntry = entry;
  }

  if (sessionKey && (sessionEntryHandle || sessionStore)) {
    // Even a reusable snapshot crosses an await. Return the current row so the
    // reply caller cannot restore stale metadata or a retired session generation.
    const current = storePath
      ? await readSessionEntryInWorker(
          { agentId, storePath, sessionKey, env },
          assertCurrent,
          undefined,
          undefined,
          params.reader,
        )
      : sessionEntryHandle
        ? sessionEntryHandle.get(sessionKey)
        : sessionStore?.[sessionKey];
    assertCurrent();
    if (storePath) {
      publishReplySessionEntry(params, current);
    }
    if (
      current?.sessionId !== expectedSession?.sessionId ||
      current?.lifecycleRevision !== expectedSession?.lifecycleRevision
    ) {
      return readSkillSnapshotState(current);
    }
    nextEntry = current;
    systemSent = current?.systemSent ?? false;
  }

  return { sessionEntry: nextEntry, skillsSnapshot, systemSent };
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
