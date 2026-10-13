import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isToolAuthorityReadCaptureActive,
  recordPreparedToolAuthorityRead,
  type PreparedToolAuthorityRead,
} from "../../agents/harness/host-private-capabilities.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { readIncognitoSessionSteeringEntry } from "../../config/sessions/session-accessor.sqlite-incognito-sharing.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { getSessionActorStorageBinding } from "../../config/sessions/session-actor-storage-binding.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
} from "../../config/sessions/session-entry-read-request.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionBinding } from "../../config/sessions/session-incognito-binding.js";
import {
  collectSessionEntryLookupKeys,
  resolveSessionEntryCandidates,
} from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { MessageInjectionTargetUnavailableError } from "./message-injection-authority.js";

function prepareCurrentSteeringRead(assertCurrent: () => void) {
  return {
    assertCurrent,
    release() {},
    prepareCurrent: async () => {
      assertCurrent();
      if (isToolAuthorityReadCaptureActive()) {
        recordPreparedToolAuthorityRead({
          reads: [],
          assertPrepared: assertCurrent,
          assertLegacyCurrent: assertCurrent,
        });
      }
    },
  };
}

/** Carry terminal-delivery eligibility into the target's final prepared admission. */
export function prepareSteeringDelivery(params: {
  agentId: string;
  sessionKey?: string;
  storePath?: string;
  sessionId?: string;
  sourceTurnId?: string;
  entry?: SessionEntry;
  assertCurrent: () => void;
}) {
  const fallbackEntry = params.entry ? structuredClone(params.entry) : undefined;
  const assertEntry = (
    current: Parameters<typeof resolveRestartRecoverySteeringBlockReason>[0],
  ) => {
    params.assertCurrent();
    const entry = current ?? fallbackEntry;
    const reason = resolveRestartRecoverySteeringBlockReason(
      entry,
      params.sessionId ?? entry?.sessionId ?? "",
      params.sourceTurnId ??
        normalizeOptionalString(entry?.restartRecoveryDeliverySourceRunId) ??
        "",
    );
    if (reason) {
      throw new MessageInjectionTargetUnavailableError(
        `Terminal source-reply delivery is closed (${reason})`,
      );
    }
  };
  if (!params.sessionKey || !params.storePath) {
    return prepareCurrentSteeringRead(() => assertEntry(fallbackEntry));
  }
  const { scope, agentId } = captureSessionEntryReadScope({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  const memory = getSessionActorStorageBinding(scope);
  if (memory) {
    return prepareCurrentSteeringRead(() => {
      assertEntry(memory.actor.snapshot(memory.authority)?.entry);
    });
  }
  const binding = captureIncognitoSessionBinding(scope);
  if (binding) {
    const claim = binding.actor.sessions.captureCurrent(scope.sessionKey);
    const assertActorCurrent = () => {
      params.assertCurrent();
      binding.admissionSignal?.throwIfAborted();
      binding.actor.assertReadable();
      claim.assertCurrent();
      assertEntry(binding.actor.sessions.readSteering(scope.sessionKey));
    };
    return prepareCurrentSteeringRead(assertActorCurrent);
  }
  if (isNativeSessionEntryRead(scope, agentId)) {
    const storePath = isIncognitoSessionKey(scope.sessionKey)
      ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: params.agentId, env: scope.env })
      : scope.storePath!;
    const owner = getOpenIncognitoAgentDatabase(params.agentId, storePath);
    const assertNativeCurrent = () => {
      params.assertCurrent();
      if (getOpenIncognitoAgentDatabase(params.agentId, storePath) !== owner) {
        throw new Error("Steering delivery incognito owner changed");
      }
      assertEntry(
        owner ? readIncognitoSessionSteeringEntry(owner.db, scope.sessionKey) : undefined,
      );
    };
    return prepareCurrentSteeringRead(assertNativeCurrent);
  }
  const sessionKey = resolveSqliteSessionKey(scope.sessionKey, params.agentId);
  let active = true;
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  let unregister: (() => void) | undefined;
  let preparation: Promise<void> | undefined;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    retained?.release();
    unregister?.();
  };
  const assertCurrent = () => {
    params.assertCurrent();
    if (!active || !retained?.isCurrent()) {
      throw new MessageInjectionTargetUnavailableError("Terminal delivery eligibility changed");
    }
  };
  const prepare = async () => {
    params.assertCurrent();
    await withSessionEntriesFromStoresInWorker(
      [
        {
          agentId: params.agentId,
          storePath: scope.storePath!,
          env: scope.env,
          projection: "exact",
          snapshotFields: [],
          sessionKeys: [...new Set([sessionKey, ...collectSessionEntryLookupKeys(sessionKey)])],
        },
      ],
      ([read]) => {
        params.assertCurrent();
        if (!active || !read) {
          throw new MessageInjectionTargetUnavailableError("Steering preparation was released");
        }
        const selected = resolveSessionEntryCandidates({
          entries: read.result.entries,
          sessionKey,
          canonicalKeys: true,
        }).existing;
        assertEntry(selected?.entry);
        const identity =
          read.result.source?.databaseIdentity ?? read.result.databaseIdentity?.identity;
        if (!identity) {
          throw new MessageInjectionTargetUnavailableError(
            "Steering session source is unavailable",
          );
        }
        retained = retainPreparedSessionEntryPredicate({
          databaseIdentity: `file:${identity}`,
          sessionKey: selected?.sessionKey ?? sessionKey,
          entry: selected?.entry,
          matches: (before, after) =>
            before?.sessionId === after?.sessionId &&
            before?.lifecycleRevision === after?.lifecycleRevision &&
            !resolveRestartRecoverySteeringBlockReason(
              after ?? fallbackEntry,
              params.sessionId ?? after?.sessionId ?? "",
              params.sourceTurnId ??
                normalizeOptionalString(after?.restartRecoveryDeliverySourceRunId) ??
                "",
            ),
        });
        unregister = registerOpenClawAgentDatabaseAsyncResource({
          agentId: read.database.agentId,
          path: read.database.path,
          revoke: release,
          close: async () => release(),
        });
      },
      { ordered: true },
    );
    assertCurrent();
  };
  const descriptor: PreparedToolAuthorityRead = {
    reads: [],
    assertPrepared: assertCurrent,
    assertLegacyCurrent: assertCurrent,
  };
  return {
    assertCurrent,
    release,
    prepareCurrent: async () => {
      preparation ??= prepare();
      await preparation;
      assertCurrent();
      if (isToolAuthorityReadCaptureActive()) {
        recordPreparedToolAuthorityRead(descriptor);
      }
    },
  };
}
