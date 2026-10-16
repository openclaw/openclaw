import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isToolAuthorityReadCaptureActive,
  recordPreparedToolAuthorityRead,
  type PreparedToolAuthorityRead,
} from "../../agents/harness/host-private-capabilities.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { retainPreparedSessionEntryPredicate } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { resolveSqliteSessionKey } from "../../config/sessions/session-accessor.sqlite-scope-helpers.js";
import { captureSessionActorStorageOwner } from "../../config/sessions/session-actor-storage-binding.js";
import { captureSessionEntryReadScope } from "../../config/sessions/session-entry-read-request.js";
import { withSessionEntriesFromStoresInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import {
  collectSessionEntryLookupKeys,
  resolveSessionEntryCandidates,
} from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
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
  const fallbackEntry = params.entry;
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
  const memory = captureSessionActorStorageOwner(params, { assertCurrent() {}, authorize() {} });
  if (memory) {
    const sessionKey = params.sessionKey;
    return prepareCurrentSteeringRead(() => {
      const current =
        memory.binding?.actor.target.sessionKey === sessionKey
          ? memory.binding.actor.snapshot(memory.authority)
          : memory.owner?.readSession(sessionKey, memory.authority);
      if (!current?.entry) {
        throw new MessageInjectionTargetUnavailableError("Steering target session was closed");
      }
      assertEntry(current.entry);
    });
  }
  const { scope } = captureSessionEntryReadScope({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
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
