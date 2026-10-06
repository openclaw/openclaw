import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isToolAuthorityReadCaptureActive,
  recordPreparedToolAuthorityRead,
  type PreparedToolAuthorityRead,
} from "../../agents/harness/host-private-capabilities.js";
import { resolveRestartRecoverySteeringBlockReason } from "../../config/sessions/restart-recovery-receipt.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { readIncognitoSessionSteeringEntry } from "../../config/sessions/session-accessor.sqlite-incognito-sharing.js";
import {
  captureSessionEntryReadScope,
  isNativeSessionEntryRead,
  withSessionEntriesFromStoresInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "../../config/sessions/session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "../../config/sessions/session-store-target-inventory.js";
import {
  collectSessionEntryLookupKeys,
  normalizeStoreSessionKey,
  resolveSessionEntryCandidates,
} from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { MessageInjectionTargetUnavailableError } from "./message-injection-authority.js";

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
    return {
      prepareCurrent: async () => assertEntry(fallbackEntry),
    };
  }
  const { scope, agentId } = captureSessionEntryReadScope({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
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
    return {
      prepareCurrent: async () => {
        assertNativeCurrent();
        if (isToolAuthorityReadCaptureActive()) {
          recordPreparedToolAuthorityRead({
            reads: [],
            assertPrepared: assertNativeCurrent,
            assertLegacyCurrent: assertNativeCurrent,
          });
        }
      },
    };
  }
  const candidates = captureSessionStoreReadCandidates(scope.storePath!);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  let selectedPath: string | undefined;
  const assertSources = () => {
    params.assertCurrent();
    for (const candidate of candidates) {
      assertSessionStoreReadCandidate(candidate.path, candidates);
    }
    for (const [path, expected] of identities) {
      const current = readDatabasePathIdentitySync(path);
      if (
        current.key !== expected.key ||
        current.canonicalPath !== expected.canonicalPath ||
        current.birthtime !== expected.birthtime
      ) {
        throw new Error("Steering delivery source changed during preparation");
      }
    }
  };
  const assertLegacyCurrent = () => {
    assertSources();
    assertEntry(loadSessionEntry({ ...scope, readConsistency: "latest" }));
    assertSources();
  };
  const descriptor: PreparedToolAuthorityRead = {
    reads: [
      {
        agentId: params.agentId,
        storePath: scope.storePath!,
        env: scope.env,
        projection: "exact",
        snapshotFields: [],
        sessionKeys: [
          ...new Set([
            normalizeStoreSessionKey(scope.sessionKey),
            ...collectSessionEntryLookupKeys(scope.sessionKey),
          ]),
        ],
      },
    ],
    assertPrepared: (reads) => {
      assertSources();
      const read = reads[0]!;
      read.assertCurrent();
      const physicalPath = assertSessionStoreReadCandidate(read.database.path, candidates);
      if (selectedPath !== undefined && selectedPath !== physicalPath) {
        throw new Error("Steering delivery selected store changed");
      }
      selectedPath = physicalPath;
      assertEntry(
        resolveSessionEntryCandidates({
          entries: read.result.entries,
          sessionKey: scope.sessionKey,
          canonicalKeys: true,
        }).existing?.entry,
      );
      read.assertCurrent();
      assertSources();
    },
    assertLegacyCurrent,
  };
  return {
    prepareCurrent: async () => {
      assertSources();
      if (isToolAuthorityReadCaptureActive()) {
        recordPreparedToolAuthorityRead(descriptor);
      } else {
        await withSessionEntriesFromStoresInWorker(descriptor.reads, descriptor.assertPrepared, {
          prepareSource: (_input, database, identity) => {
            assertSources();
            const physicalPath = assertSessionStoreReadCandidate(database.path, candidates);
            if (selectedPath !== undefined && selectedPath !== physicalPath) {
              throw new Error("Steering delivery selected store changed");
            }
            selectedPath = physicalPath;
            if (!identities.has(identity.canonicalPath)) {
              identities.set(identity.canonicalPath, identity);
            }
          },
        });
      }
      assertSources();
    },
  };
}
