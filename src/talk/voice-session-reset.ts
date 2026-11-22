import { randomUUID } from "node:crypto";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-operator-authority.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeLogger } from "../plugins/runtime/types-core.js";
import { isModelSelectionLocked } from "../sessions/model-overrides.js";

// The configured session reset for voice consults (#185942), kept beside the consult runtime.

/** The reset due for a consult's session; blocked and model-locked sessions never reset here. */
async function resolveDueConsultReset(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry | undefined;
  messageProvider: string;
}): Promise<{ reason: "daily" | "idle" | "reset"; entry: SessionEntry } | undefined> {
  const { cfg, agentId, sessionKey, storePath, entry } = params;
  if (!entry?.sessionId?.trim() || isModelSelectionLocked(entry)) {
    return undefined;
  }
  const [
    { resolveSessionEntryResetFreshnessAsync },
    { resolveChannelResetConfig, resolveSessionResetType },
    { resolveSessionWorkStartError },
  ] = await Promise.all([
    import("../config/sessions/entry-freshness.js"),
    import("../config/sessions/reset.js"),
    import("../config/sessions/lifecycle.js"),
  ]);
  if (resolveSessionWorkStartError(sessionKey, entry)) {
    return undefined;
  }
  const resolved = await resolveSessionEntryResetFreshnessAsync({
    agentId,
    sessionKey,
    storePath,
    sessionCfg: cfg.session,
    resetType: resolveSessionResetType({ sessionKey }),
    resetOverride: resolveChannelResetConfig({
      sessionCfg: cfg.session,
      // The consult's own surface picks the policy (browser Talk: webchat; phone and FaceTime:
      // voice), as typed turns use their ingress channel; stored delivery routes replies only.
      channel: params.messageProvider,
    }),
  });
  if (resolved.state !== "stale") {
    return undefined;
  }
  // A stale entry without a reason carries a reset owed by a deferred rollover.
  return { reason: resolved.freshness.staleReason ?? "reset", entry: resolved.entry };
}

/** A stale session rolls over in place, as for typed turns, instead of replaying old context. */
export async function rollOverStaleConsultSession(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath: string;
  cwd: string;
  entry: SessionEntry | undefined;
  logger: Pick<RuntimeLogger, "warn">;
  abortSignal?: AbortSignal;
  assertSourceCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  messageProvider: string;
}): Promise<boolean> {
  const { agentId, storePath, entry } = params;
  if (!entry || !(await resolveDueConsultReset(params))) {
    return false;
  }
  const [
    { resolveSqliteSessionKey },
    { resetSessionEntryLifecycle },
    { createSessionWorkStartChangedError, resolveSessionWorkStartError },
    { normalizeStoreSessionKey },
    { clearRotatedSessionMetadata },
    { clearCommittedSessionResetRuntimeState },
    { runSessionMutation },
    { assertOperatorAccessProgramAllowed },
    { captureSessionMemoryTranscript },
    { emitSessionAutoResetHook, hasSessionAutoResetListeners, isSessionAutoResetReason },
    { resetSessionAgentHarnesses },
  ] = await Promise.all([
    import("../config/sessions/session-accessor.sqlite-scope-helpers.js"),
    import("../config/sessions/session-accessor.lifecycle.js"),
    import("../config/sessions/lifecycle.js"),
    import("../config/sessions/store-entry.js"),
    import("../agents/session-reset-metadata.js"),
    import("../auto-reply/reply/session-reset-cleanup.js"),
    import("../sessions/session-controller.lifecycle.js"),
    import("../agents/admitted-run-context.js"),
    import("../hooks/bundled/session-memory/capture.js"),
    import("../hooks/session-auto-reset.js"),
    import("../gateway/session-lifecycle-cleanup.js"),
  ]);
  // Reads qualify short keys (`voice:consult`); the reset targets the same row.
  const sessionKey = resolveSqliteSessionKey(params.sessionKey, agentId);
  // Typed rollover's controller lane: wait for the old turn instead of cancelling it.
  return await runSessionMutation({
    scope: storePath,
    identities: [params.sessionKey, sessionKey, entry.sessionId],
    requiredSessionId: entry.sessionId,
    signal: params.abortSignal,
    kind: "reset",
    policy: "wait",
    run: async () => {
      // A turn that ran during the wait may have refreshed the session; re-read before resetting.
      const due = await resolveDueConsultReset(params);
      if (!due) {
        return false;
      }
      const { reason: dueReason, entry: current } = due;
      if (
        current.sessionId !== entry.sessionId ||
        current.lifecycleRevision !== entry.lifecycleRevision
      ) {
        throw createSessionWorkStartChangedError(sessionKey);
      }
      // A model lock or work-start block set during the wait stops the reset, as on the first check.
      if (isModelSelectionLocked(current) || resolveSessionWorkStartError(sessionKey, current)) {
        return false;
      }
      const ended = { agentId, sessionId: entry.sessionId, sessionKey, storePath };
      const autoReason = isSessionAutoResetReason(dueReason) ? dueReason : undefined;
      // Session memory saves the ended day; capture it before the same-identity reset hides it.
      const previousSessionMemory =
        autoReason && hasSessionAutoResetListeners()
          ? await captureSessionMemoryTranscript(ended, params.cfg)
          : undefined;
      // One admission before any effect: a cancelled consult, a caller without authority, or one
      // the session's Access program refuses starts no reset. Once native cleanup starts, the due
      // reset settles even if the call closes, so the transcript and native conversation stay in
      // step; the session lane and the entry checks below still reject a changed session.
      params.abortSignal?.throwIfAborted();
      params.assertSourceCurrent?.();
      assertOperatorAccessProgramAllowed(params.operatorAuthority, current.cyberAccessProgram);
      // As typed rollover does, before the commit: native harnesses (ACP) keep their own
      // conversation under the unchanged session id. A harness-declared cleanup failure stops the
      // reset, so the session stays due and is retried; the registry logs other hook failures, as
      // for typed and Gateway resets.
      await resetSessionAgentHarnesses({
        cfg: params.cfg,
        target: { agentId, canonicalKey: sessionKey },
        entry,
        reason: autoReason ?? "unknown",
      });
      await resetSessionEntryLifecycle({
        agentId,
        storePath,
        target: { canonicalKey: normalizeStoreSessionKey(sessionKey), storeKeys: [sessionKey] },
        resetBoundary: {
          context: "preserve-tail",
          reason: dueReason,
          cwd: params.cwd,
        },
        buildNextEntry: ({ currentEntry }) => {
          if (
            !currentEntry ||
            currentEntry.sessionId !== entry.sessionId ||
            currentEntry.lifecycleRevision !== entry.lifecycleRevision ||
            resolveSessionWorkStartError(sessionKey, currentEntry)
          ) {
            throw createSessionWorkStartChangedError(sessionKey);
          }
          // Timed after any wait for the old turn, so the new session is not stale on arrival.
          const now = Date.now();
          return {
            ...clearRotatedSessionMetadata(currentEntry),
            lifecycleRevision: randomUUID(),
            agentHarnessId: undefined,
            sessionStartedAt: now,
            lastInteractionAt: now,
            updatedAt: now,
          };
        },
      });
      // The reset is committed: the steps below finish it even if the caller goes away.
      emitSessionAutoResetHook({
        ...ended,
        cfg: params.cfg,
        reason: autoReason,
        nextSessionId: entry.sessionId,
        nextSessionKey: sessionKey,
        workspaceDir: entry.spawnedWorkspaceDir,
        previousSessionMemory,
      });
      clearCommittedSessionResetRuntimeState({
        previousSessionEntry: entry,
        agentId,
        // The consult's own controller and queues use the caller's key.
        sessionKey: params.sessionKey,
        storePath,
        // Automatic voice rollover clears old context, not unanswered user requests.
        preserveControllerInputs: true,
        onError: (error) =>
          params.logger.warn(
            `[talk] failed to clear session reset runtime state: ${String(error)}`,
          ),
      });
      return true;
    },
  });
}
