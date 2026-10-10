import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { resolveCollapsedSessionAuthPinSource } from "./auth-profile-override-provenance.js";
import {
  readIncognitoSessionEntryCurrent,
  readCommittedIncognitoSessionAuthProfile,
  type IncognitoSessionAuthProfileFacts,
} from "./session-accessor.sqlite-incognito-sharing.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import type {
  CapturedSessionEntryCurrentRead,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";
import type { SessionEntryReadWorkerOwner } from "./session-entry-read-runtime.js";
import {
  captureIncognitoSessionBinding,
  type IncognitoSessionBinding,
} from "./session-incognito-binding.js";
import { isSessionStoreReadCandidateCurrent } from "./session-store-read-candidates.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { SessionEntry } from "./types.js";

function captureIncognitoSessionEntryCurrentRead(
  binding: IncognitoSessionBinding,
  sessionKey: string,
): Exclude<CapturedSessionEntryCurrentRead, { kind: "file" }> & {
  readAuthProfileCurrent(): IncognitoSessionAuthProfileFacts | undefined;
} {
  const { actor, admissionSignal } = binding;
  const claim = actor.sessions.captureCurrent(sessionKey);
  const assertSourceCurrent = () => {
    admissionSignal?.throwIfAborted();
    actor.assertReadable();
    claim.assertCurrent();
  };
  return {
    kind: "incognito",
    assertSourceCurrent,
    readCurrent() {
      assertSourceCurrent();
      return actor.sessions.readSharing(sessionKey)?.entry;
    },
    readAuthProfileCurrent() {
      assertSourceCurrent();
      return actor.sessions.readAuthProfile(sessionKey);
    },
  };
}

/** Process-held currency consumes its original writer's published facts, never a native query. */
export function captureNativeSessionEntryCurrentRead(scope: SessionEntryReadScope): Exclude<
  CapturedSessionEntryCurrentRead,
  { kind: "file" }
> & {
  readAuthProfileCurrent(): IncognitoSessionAuthProfileFacts | undefined;
} {
  const sessionKey = scope.sessionKey;
  const agentId = scope.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  assertCanonicalSessionKeyWrite(sessionKey, agentId);
  if (!agentId) {
    throw new Error("Session currency requires its original agent");
  }
  const binding = captureIncognitoSessionBinding(scope);
  if (binding) {
    return captureIncognitoSessionEntryCurrentRead(binding, sessionKey);
  }
  const env = captureSessionTranscriptStorageEnvironment(scope.env ?? process.env);
  const storePath = isIncognitoSessionKey(sessionKey)
    ? resolveIncognitoOpenClawAgentSqlitePath({ agentId, env })
    : scope.storePath;
  if (!storePath) {
    throw new Error("Session currency requires its original incognito store");
  }
  const database = getOpenIncognitoAgentDatabase(agentId, storePath);
  const assertSourceCurrent = () => {
    if (getOpenIncognitoAgentDatabase(agentId, storePath) !== database) {
      throw new Error("Session currency incognito owner changed");
    }
  };
  return {
    kind: database ? "native" : "missing",
    assertSourceCurrent,
    readCurrent() {
      assertSourceCurrent();
      return database ? readIncognitoSessionEntryCurrent(database.db, sessionKey) : undefined;
    },
    readAuthProfileCurrent() {
      assertSourceCurrent();
      return database
        ? readCommittedIncognitoSessionAuthProfile(database.db, sessionKey)
        : undefined;
    },
  };
}

/** Capture during the initial admitted read; later checks acquire only finite worker custody. */
export function captureSessionEntryCurrentRead(
  scope: SessionEntryReadScope,
  owner: SessionEntryReadWorkerOwner,
): CapturedSessionEntryCurrentRead {
  owner.assertCurrent();
  const sessionKey = scope.sessionKey;
  const agentId = scope.agentId ?? parseAgentSessionKey(sessionKey)?.agentId;
  assertCanonicalSessionKeyWrite(sessionKey, agentId);
  if (owner.incognito) {
    return captureIncognitoSessionEntryCurrentRead(owner.incognito, sessionKey);
  }
  if (owner.kind === "incognito") {
    return {
      kind: "missing",
      assertSourceCurrent: owner.assertCurrent,
      readCurrent() {
        owner.assertCurrent();
        return undefined;
      },
    };
  }
  if (owner.kind === "native") {
    return captureNativeSessionEntryCurrentRead(scope);
  }
  if (owner.kind !== "file" || !owner.scope || !owner.selectedStore) {
    throw new Error("Session currency source is unavailable");
  }
  const readScope = {
    ...owner.scope,
    env: captureSessionTranscriptStorageEnvironment(owner.scope.env),
  };
  const candidate = { ...owner.selectedStore };
  if (candidate.physicalPath !== readScope.storePath) {
    throw new Error("Session currency selected store differs from its admitted source");
  }
  const identity = readDatabasePathIdentitySync(readScope.storePath);
  owner.assertCurrent();
  const assertLogicalSourceCurrent = () => {
    if (!isSessionStoreReadCandidateCurrent(candidate)) {
      throw new Error("Session currency logical source changed");
    }
  };
  assertLogicalSourceCurrent();
  if (!identity.key.startsWith("file:")) {
    const assertSourceCurrent = () => {
      const current = readDatabasePathIdentitySync(readScope.storePath);
      if (current.key !== identity.key || current.canonicalPath !== identity.canonicalPath) {
        throw new Error("Session currency missing source changed");
      }
      assertLogicalSourceCurrent();
    };
    return {
      kind: "missing",
      assertSourceCurrent,
      readCurrent() {
        assertSourceCurrent();
        return undefined;
      },
    };
  }
  const source: SessionEntryCurrentSource = Object.freeze({
    agentId: readScope.databaseAgentId,
    path: readScope.storePath,
    databaseIdentity: identity.key.slice("file:".length),
    databaseBirthtime: identity.birthtime,
    sessionKey,
  });
  const assertSourceCurrent = () => {
    assertExistingDatabaseIdentity(source.path, identity.key, identity.birthtime);
    assertLogicalSourceCurrent();
  };
  const options = { agentId: source.agentId, path: source.path, env: readScope.env };
  return {
    kind: "file",
    source,
    assertSourceCurrent,
    async readCurrent() {
      const entry = await withSessionHistoryWorkerDatabase(options, (reader) =>
        reader.readEntryCurrent({ scope: readScope, source }),
      );
      assertSourceCurrent();
      return entry;
    },
  };
}

const runtimeAuthProfileExecution = Symbol("runtimeAuthProfileExecution");

type RuntimeAuthProfileExecution = {
  sessionId?: string;
  authProfileId?: string;
  [runtimeAuthProfileExecution]?: {
    target: SessionEntryReadScope & { sessionId: string };
    nativeRead?: ReturnType<typeof captureNativeSessionEntryCurrentRead>;
    lifecycleRevision: SessionEntry["lifecycleRevision"];
    pin: string | undefined;
    selectedProfileId: string | undefined;
    readMode: "read-only" | "writable";
  };
};

function sessionAccountPin(
  entry:
    | Pick<
        SessionEntry,
        "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
      >
    | undefined,
): string | undefined {
  return resolveCollapsedSessionAuthPinSource(entry) === "user"
    ? entry?.authProfileOverride?.trim() || undefined
    : undefined;
}

/** Retain the admitted account intent through runtime-only parameter spreads. */
export function bindRuntimeAuthProfileExecution<T extends RuntimeAuthProfileExecution>(
  params: T,
  target: (SessionEntryReadScope & { sessionId: string }) | undefined,
  entry:
    | (Pick<
        SessionEntry,
        "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
      > &
        Pick<SessionEntry, "lifecycleRevision">)
    | undefined,
  selectedProfileId?: string,
  readMode: "read-only" | "writable" = "read-only",
): T {
  delete params[runtimeAuthProfileExecution];
  if (!target) {
    return params;
  }
  const agentId = target.agentId ?? parseAgentSessionKey(target.sessionKey)?.agentId;
  const nativeRead =
    (target.storePath && agentId && getOpenIncognitoAgentDatabase(agentId, target.storePath)) ||
    isIncognitoSessionKey(target.sessionKey) ||
    (target.storePath &&
      agentId &&
      isIncognitoOpenClawAgentSqlitePath(target.storePath, {
        agentId,
        env: target.env,
      }))
      ? captureNativeSessionEntryCurrentRead(target)
      : undefined;
  return Object.assign(params, {
    [runtimeAuthProfileExecution]: {
      target: { ...target },
      nativeRead,
      lifecycleRevision: entry?.lifecycleRevision,
      pin: sessionAccountPin(entry),
      selectedProfileId: selectedProfileId?.trim(),
      readMode,
    },
  });
}

/** Credential use and dispatch consume the current row after their own preparation waits. */
export async function prepareRuntimeAuthProfileExecution(
  params: RuntimeAuthProfileExecution,
  assertCurrent: () => void,
): Promise<void> {
  const binding = params[runtimeAuthProfileExecution];
  if (!binding) {
    return;
  }
  assertCurrent();
  const { readSessionEntryInWorker, withSessionEntryReadOnlyInWorker } =
    await import("./session-entry-read-runtime.js");
  assertCurrent();
  const target = {
    ...binding.target,
    readConsistency: "latest" as const,
    hydrateSkillPromptRefs: false,
  };
  const entry = binding.nativeRead
    ? binding.nativeRead.readAuthProfileCurrent()
    : binding.readMode === "read-only"
      ? await withSessionEntryReadOnlyInWorker(target, assertCurrent, async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          return read.value;
        })
      : await readSessionEntryInWorker(target, assertCurrent);
  assertCurrent();
  const pin = sessionAccountPin(entry);
  if (
    !entry ||
    entry.sessionId !== binding.target.sessionId ||
    entry.lifecycleRevision !== binding.lifecycleRevision
  ) {
    const { createAgentRunSupersededAbortError } = await import("../../agents/run-termination.js");
    assertCurrent();
    throw createAgentRunSupersededAbortError();
  }
  if (
    pin !== binding.pin &&
    (!pin || (pin !== params.authProfileId?.trim() && pin !== binding.selectedProfileId))
  ) {
    throw new Error(
      "Session account pin changed during preparation; retry with the current account.",
    );
  }
}
