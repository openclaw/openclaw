/** Owns admission and persistence for isolated cron sessions. */
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalAgentRuntimeId } from "../../agents/agent-runtime-id.js";
import type { LiveSessionModelSelection } from "../../agents/live-model-switch.js";
import { applyModelRuntimeDirective } from "../../auto-reply/reply/directive-handling.model-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { resolveSessionWorkStartError } from "../../config/sessions/lifecycle.js";
import type { SessionResetBoundaryWrite } from "../../config/sessions/session-accessor.lifecycle-types.js";
import type { SessionEntryPatchOperation } from "../../config/sessions/session-entry-patch-operation.js";
import {
  buildSessionCreationStamp,
  inheritSessionCreationPolicy,
} from "../../config/sessions/session-entry-provenance.js";
import type { SessionCreatedActor } from "../../config/sessions/session-entry-provenance.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import { readSessionTranscriptWatermarkAsync } from "../../config/sessions/session-transcript-watermark.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/work-start-error.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { isCronSessionKey } from "../../sessions/session-key-utils.js";
import { CronSessionLifecycleClaimError } from "../run-authority.js";
import {
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
  normalizeCronToolsAllowExecTarget,
  normalizeCronToolsAllowExecTargetRequirement,
  stripCronPinnedExecGrant,
} from "../scheduled-tool-policy.js";
import type {
  CronScheduledToolCallerOrigin,
  CronScheduledToolPolicy,
  CronToolsAllowExecTarget,
  CronToolsAllowExecTargetRequirement,
} from "../scheduled-tool-policy.js";
import { setSessionRuntimeModel } from "./run.runtime.js";
import type { CronLaneWaitCallback } from "./run.types.js";
import { loadCronSessionEntryLatest, type resolveCronSession } from "./session.js";

/** Hold the controller claim through preparation, inference, delivery, and cleanup. */
export async function withCronSessionPreparation<T>(
  params: {
    agentId: string;
    storePath: string;
    sessionKey: string;
    signal?: AbortSignal;
    onInterrupt: () => void;
    onLaneWait?: CronLaneWaitCallback;
  },
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  params.onLaneWait?.({ waiting: true, stage: "session-preparation" });
  return await withSessionTurn(
    {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      abortSignal: params.signal,
      onCancelled: params.onInterrupt,
    },
    async (_operation, signal) => {
      params.onLaneWait?.({ waiting: false, stage: "session-preparation" });
      return await run(signal);
    },
  );
}

function clearCronContextOwnerState(entry: SessionEntry) {
  delete entry.contextTokens;
  delete entry.contextTokensSource;
  delete entry.contextBudgetStatus;
}

/** Resolved cron session plus its mutable backing store and active entry. */
export type MutableCronSession = ReturnType<typeof resolveCronSession>;

/** Commits a closed cron operation and returns its acknowledged entry. */
export type CronSessionRowWriter = (params: {
  operation: Extract<SessionEntryPatchOperation, { kind: "cron-session" }>;
  resetBoundary?: SessionResetBoundaryWrite;
  sessionKey: string;
  storePath: string;
  assertCommitAllowed?: () => void;
}) => Promise<SessionEntry | null>;

/** Persists the currently selected mutable cron session entry to the session store. */
export type PersistCronSessionEntry = (
  assertCommitAllowed?: () => void,
  entry?: SessionEntry,
) => Promise<void>;

/** Hidden exact-run row retained while detached cron work can still resume. */
export type CronRunContinuationSession = {
  initialize: () => Promise<void>;
  sync: (
    assertCommitAllowed?: () => void,
    execution?: { cliExecutionProvider?: string },
  ) => Promise<void>;
  seal: (options?: { basePersisted?: boolean }) => Promise<void>;
};

function resolveCronLifecycleRevisionIdentity(lifecycleRevision: string): string {
  return `cron-lifecycle-revision:${lifecycleRevision}`;
}

/** Claim the captured session generation before asynchronous run preparation. */
export async function beginCronPreparationEffect(params: {
  agentId: string;
  cronSession: MutableCronSession;
  agentSessionKey: string;
  runSessionKey: string;
  usesDetachedRunSession: boolean;
  signal?: AbortSignal;
  onInterrupt: () => void;
}) {
  const { cronSession, agentSessionKey, runSessionKey } = params;
  const initialSessionEntry = cronSession.initialSessionEntry;
  // Metadata and workspace custody follows the same controller as native execution.
  return await beginSessionEffect({
    agentId: params.agentId,
    target: captureSessionTarget({
      storeScope: cronSession.storePath,
      sessionKey: runSessionKey,
      incarnation: cronSession.sessionEntry.sessionId,
      aliases: [
        agentSessionKey,
        initialSessionEntry?.sessionId,
        resolveCronLifecycleRevisionIdentity(cronSession.lifecycleRevision),
      ],
    }),
    signal: params.signal,
    onInterrupt: params.onInterrupt,
    assertAllowed: async (signal) => {
      // Bound sessions borrow workspace authority; detached rows claim only at their write.
      if (params.usesDetachedRunSession) {
        return;
      }
      const currentEntry = await loadCronSessionEntryLatest(cronSession.storePath, agentSessionKey);
      signal.throwIfAborted();
      const changed = initialSessionEntry
        ? !currentEntry ||
          !isDeepStrictEqual(
            projectCronOwnershipFields(currentEntry),
            projectCronOwnershipFields(initialSessionEntry),
          )
        : Boolean(currentEntry);
      if (changed) {
        throw new CronSessionLifecycleClaimError(agentSessionKey);
      }
      const archivedSessionError = resolveSessionWorkStartError(agentSessionKey, currentEntry);
      if (archivedSessionError) {
        throw new CronSessionLifecycleClaimError(agentSessionKey, archivedSessionError);
      }
    },
  });
}

async function cronTranscriptExists(params: {
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<boolean> {
  const sessionId = params.entry.sessionId?.trim();
  if (!sessionId) {
    return false;
  }
  try {
    const watermark = await readSessionTranscriptWatermarkAsync({
      sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    });
    // Sequence zero is a real header; cold archives retain their last sequence.
    return watermark.maxSeq !== null;
  } catch {
    return false;
  }
}

function projectCronOwnershipFields(entry: SessionEntry): Partial<SessionEntry> {
  // SQL omits absent fields; published snapshots can retain them as undefined.
  const projected: Partial<SessionEntry> = Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  );
  delete projected.label;
  delete projected.pinnedAt;
  delete projected.updatedAt;
  return projected;
}

function toNonResumableCronSessionEntry(entry: SessionEntry): SessionEntry {
  const next = { ...entry };
  // If the transcript never materialized, do not persist stale resume handles
  // that would make the next cron run believe a resumable CLI session exists.
  delete next.sessionStartedAt;
  delete next.lastInteractionAt;
  delete next.cliSessionIds;
  delete next.cliSessionBindings;
  delete next.claudeCliSessionId;
  return next;
}

/** Creates the persistence callback that stores cron session metadata after a run. */
export function createPersistCronSessionEntry(params: {
  cronSession: MutableCronSession;
  agentSessionKey: string;
  createdActor?: SessionCreatedActor;
  sandbox?: "required";
  workspaceDir: string;
  persistSessionEntry: CronSessionRowWriter;
}): PersistCronSessionEntry {
  return async (assertCommitAllowed, liveEntry = params.cronSession.sessionEntry) => {
    const resetBoundaryPending = params.cronSession.resetBoundaryPending !== undefined;
    // Reset admission completes before a CLI turn can own settlement.
    if (assertCommitAllowed && resetBoundaryPending) {
      throw new CronSessionLifecycleClaimError(params.agentSessionKey);
    }
    const persistedEntry =
      isCronSessionKey(params.agentSessionKey) &&
      liveEntry.sessionId &&
      (liveEntry.cliSessionIds !== undefined ||
        liveEntry.cliSessionBindings !== undefined ||
        liveEntry.claudeCliSessionId !== undefined) &&
      !(await cronTranscriptExists({
        entry: liveEntry,
        sessionKey: params.agentSessionKey,
        storePath: params.cronSession.storePath,
      }))
        ? toNonResumableCronSessionEntry(liveEntry)
        : liveEntry;
    let committedEntry: SessionEntry | null;
    try {
      committedEntry = await params.persistSessionEntry({
        storePath: params.cronSession.storePath,
        sessionKey: params.agentSessionKey,
        operation: {
          kind: "cron-session",
          sessionKey: params.agentSessionKey,
          initial: params.cronSession.initialSessionEntry,
          next: persistedEntry,
          creation: buildSessionCreationStamp({
            via: "cron",
            actor: params.createdActor ?? { type: "system" },
            sandbox: params.sandbox,
          }),
        },
        assertCommitAllowed,
        ...(resetBoundaryPending
          ? {
              resetBoundary: {
                context: "preserve-tail",
                reason: "cron-stale",
                cwd: params.workspaceDir,
              } satisfies SessionResetBoundaryWrite,
            }
          : {}),
      });
    } catch (error) {
      if (isSessionWorkStartInvalidatedError(error)) {
        throw new CronSessionLifecycleClaimError(params.agentSessionKey, error.message);
      }
      throw error;
    }
    if (!committedEntry) {
      throw new CronSessionLifecycleClaimError(params.agentSessionKey);
    }
    params.cronSession.resetBoundaryPending = undefined;
    // The storage projection may intentionally omit resume identity until its
    // transcript exists. Keep that projection out of the active run object.
    params.cronSession.sessionEntry = mergeSessionSnapshotChanges({
      initial: persistedEntry,
      next: liveEntry,
      current: committedEntry,
    });
    params.cronSession.initialSessionEntry = structuredClone(committedEntry);
    params.cronSession.store[params.agentSessionKey] = committedEntry;
  };
}

/** Creates the hidden exact-run session owner used by detached media wakes. */
export function createCronRunContinuationSession(params: {
  cronSession: MutableCronSession;
  runSessionKey: string;
  createdActor?: SessionCreatedActor;
  sandbox?: "required";
  thinkingLevel?: string;
  toolsAllow?: string[];
  toolsAllowIsDefault?: boolean;
  scheduledToolPolicy?: CronScheduledToolPolicy;
  scheduledToolCallerOrigin?: CronScheduledToolCallerOrigin;
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
  toolsAllowExecTargetRequirement?: CronToolsAllowExecTargetRequirement;
  cliSessionBindingFacts?: {
    extraSystemPromptStatic?: string;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    requireExplicitMessageTarget?: boolean;
  };
}): CronRunContinuationSession {
  const scheduledToolPolicy =
    params.toolsAllow === undefined
      ? undefined
      : normalizeCronScheduledToolPolicy(params.scheduledToolPolicy);
  const scheduledToolCallerOrigin = normalizeCronScheduledToolCallerOrigin(
    params.scheduledToolCallerOrigin,
  );
  const toolsAllowExecTarget =
    params.toolsAllow === undefined
      ? undefined
      : normalizeCronToolsAllowExecTarget(params.toolsAllowExecTarget);
  const toolsAllowExecTargetRequirement =
    params.toolsAllow === undefined
      ? undefined
      : normalizeCronToolsAllowExecTargetRequirement(params.toolsAllowExecTargetRequirement);
  const storedToolsAllow = stripCronPinnedExecGrant({
    toolsAllow: params.toolsAllow,
    requirement: toolsAllowExecTargetRequirement,
  });
  const continuation: NonNullable<SessionEntry["cronRunContinuation"]> = {
    lifecycleRevision: params.cronSession.lifecycleRevision,
    phase: "running" as const,
    ...(storedToolsAllow !== undefined ? { toolsAllow: storedToolsAllow } : {}),
    ...(params.toolsAllowIsDefault === true ? { toolsAllowIsDefault: true } : {}),
    ...(scheduledToolPolicy ? { scheduledToolPolicy } : {}),
    ...(scheduledToolPolicy?.mode === "account" ? { scheduledToolCallerOrigin } : {}),
    ...(toolsAllowExecTarget ? { toolsAllowExecTarget } : {}),
    ...(toolsAllowExecTargetRequirement ? { toolsAllowExecTargetRequirement } : {}),
    ...(params.cliSessionBindingFacts
      ? { cliSessionBindingFacts: { ...params.cliSessionBindingFacts } }
      : {}),
  };
  let sealed = false;
  let persistedSnapshot: { source: SessionEntry; continuation: typeof continuation } | undefined;
  const persist = async (
    create: boolean,
    phase: "running" | "ready",
    basePersisted = false,
    assertCommitAllowed?: () => void,
  ) => {
    if (sealed) {
      if (phase === "ready") {
        return;
      }
      throw new CronSessionLifecycleClaimError(params.runSessionKey);
    }
    const source = structuredClone(params.cronSession.sessionEntry);
    delete source.createdVia;
    delete source.createdActor;
    delete source.createdAt;
    // Node-local lineage must not leak across keys: generation history and
    // fork ancestry describe the cron root, not this :run: node.
    delete source.previousSessionId;
    delete source.forkSource;
    delete source.usageFamilySessionIds;
    const snapshot = { source, continuation: { ...continuation } };
    if (phase === "running" && isDeepStrictEqual(snapshot, persistedSnapshot)) {
      return;
    }
    try {
      const { applySessionEntryOperation } =
        await import("../../config/sessions/session-accessor.sqlite-entry.js");
      const persisted = await applySessionEntryOperation(
        { storePath: params.cronSession.storePath, sessionKey: params.runSessionKey },
        {
          kind: "cron-run-continuation",
          sessionKey: params.runSessionKey,
          source,
          create,
          creation: buildSessionCreationStamp({
            via: "cron",
            ...inheritSessionCreationPolicy(
              params.cronSession.sessionEntry,
              params.createdActor ?? { type: "system" },
            ),
            sandbox: params.cronSession.sessionEntry.sandbox ?? params.sandbox,
          }),
          thinkingLevel: params.thinkingLevel,
          continuation: {
            ...continuation,
            phase,
            ...(phase === "ready" ? { basePersisted } : {}),
          },
        },
        {
          fallbackEntry: source,
          replaceEntry: true,
          skipMaintenance: true,
          workerGuard: { assertCurrent: assertCommitAllowed },
        },
      );
      if (!persisted) {
        throw new CronSessionLifecycleClaimError(params.runSessionKey);
      }
    } catch (error) {
      if (isSessionWorkStartInvalidatedError(error)) {
        throw new CronSessionLifecycleClaimError(params.runSessionKey, error.message);
      }
      throw error;
    }
    // Only acknowledged writes advance the snapshot. After handoff the cron
    // owner has no further writes, including its unconditional final cleanup.
    persistedSnapshot = snapshot;
    sealed = phase === "ready";
  };
  return {
    initialize: async () => await persist(true, "running"),
    sync: async (assertCommitAllowed, execution) => {
      if (execution) {
        const provider = execution.cliExecutionProvider?.trim();
        if (provider) {
          continuation.cliExecutionProvider = provider;
        } else {
          delete continuation.cliExecutionProvider;
        }
      }
      await persist(false, "running", false, assertCommitAllowed);
    },
    seal: async (options) => await persist(false, "ready", options?.basePersisted === true),
  };
}

/** Adopts the session id produced by a run and preserves usage-family lineage. */
export function adoptCronRunSessionMetadata(params: {
  entry: SessionEntry;
  sessionKey: string;
  runMeta?: {
    sessionId?: string;
    sessionFile?: string;
  };
}): boolean {
  const nextSessionId = params.runMeta?.sessionId?.trim();
  const previousSessionId = params.entry.sessionId;
  if (!nextSessionId || nextSessionId === previousSessionId) {
    return false;
  }
  params.entry.sessionId = nextSessionId;
  params.entry.usageFamilyKey = params.entry.usageFamilyKey ?? params.sessionKey;
  params.entry.usageFamilySessionIds = Array.from(
    new Set([
      ...(params.entry.usageFamilySessionIds ?? []),
      ...(previousSessionId ? [previousSessionId] : []),
      nextSessionId,
    ]),
  );
  return true;
}

/**
 * Updates the cron selection and drops facts produced by the previous model.
 * Keeping those facts after the owner tuple changes lets a later run relabel stale telemetry.
 */
export function setCronSessionRuntimeModel(params: {
  entry: SessionEntry;
  provider: string;
  model: string;
}) {
  const provider = params.provider.trim();
  const model = params.model.trim();
  if (!provider || !model) {
    return false;
  }
  const selectionChanged =
    params.entry.modelProvider?.trim() !== provider || params.entry.model?.trim() !== model;
  if (selectionChanged) {
    clearCronContextOwnerState(params.entry);
  }
  setSessionRuntimeModel(params.entry, { provider, model });
  return selectionChanged;
}

/** Updates the producing harness and drops context facts owned by the previous runtime. */
export function setCronSessionAgentHarnessId(params: {
  entry: SessionEntry;
  agentHarnessId: string | undefined;
}) {
  const previousRuntime = normalizeOptionalAgentRuntimeId(params.entry.agentHarnessId);
  const nextRuntime = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  if (previousRuntime !== nextRuntime) {
    clearCronContextOwnerState(params.entry);
  }
  params.entry.agentHarnessId = params.agentHarnessId;
  return previousRuntime !== nextRuntime;
}

/** Syncs live model/auth-profile changes from a running cron session back to storage. */
export function syncCronSessionLiveSelection(params: {
  entry: SessionEntry;
  liveSelection: LiveSessionModelSelection;
}) {
  const previousRuntime = normalizeOptionalAgentRuntimeId(params.entry.agentRuntimeOverride);
  const nextRuntime = normalizeOptionalAgentRuntimeId(params.liveSelection.agentRuntimeOverride);
  setCronSessionRuntimeModel({
    entry: params.entry,
    provider: params.liveSelection.provider,
    model: params.liveSelection.model,
  });
  if (previousRuntime !== nextRuntime) {
    clearCronContextOwnerState(params.entry);
  }
  applyModelRuntimeDirective(
    params.entry,
    params.liveSelection.agentRuntimeOverride
      ? { kind: "set", runtime: params.liveSelection.agentRuntimeOverride }
      : { kind: "clear" },
  );
  if (params.liveSelection.authProfileId) {
    const source =
      params.liveSelection.authProfileIdSource ??
      (params.entry.authProfileOverride?.trim() === params.liveSelection.authProfileId.trim()
        ? resolveSessionAuthProfileOverrideSource(params.entry)
        : "user");
    params.entry.authProfileOverride = params.liveSelection.authProfileId;
    params.entry.authProfileOverrideSource = source;
    if (source === "auto") {
      // Auto pins track their compaction generation; manual pins do not.
      params.entry.authProfileOverrideCompactionCount = params.entry.compactionCount ?? 0;
    } else {
      delete params.entry.authProfileOverrideCompactionCount;
    }
    return;
  }
  delete params.entry.authProfileOverride;
  delete params.entry.authProfileOverrideSource;
  delete params.entry.authProfileOverrideCompactionCount;
}
