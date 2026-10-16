import { recordModelFallbackStop } from "../../agents/model-fallback-stop.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveCollapsedSessionAuthPinSource } from "./auth-profile-override-provenance.js";
import { captureMemoryExactSessionReader } from "./session-accessor.memory-exact-read.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import { assertCanonicalSessionKeyWrite } from "./session-canonical-key.js";
import type {
  CapturedSessionEntryCurrentRead,
  SessionEntryCurrentSource,
} from "./session-entry-current.types.js";
import type { SessionEntryReadWorkerOwner } from "./session-entry-read-runtime.js";
import { isSessionStoreReadCandidateCurrent } from "./session-store-read-candidates.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import type { SessionEntry } from "./types.js";

/** Read live effect facts from the memory owner selected at acquisition. */
export function captureNativeSessionEntryCurrentRead(
  scope: SessionEntryReadScope,
): Exclude<CapturedSessionEntryCurrentRead, { kind: "file" }> {
  const memory = captureMemoryExactSessionReader(scope);
  if (!memory) {
    throw new Error("Session current facts require a memory owner");
  }
  return {
    kind: memory.source ? "incognito" : "missing",
    assertSourceCurrent: () => memory.assertCurrent(),
    readCurrent() {
      return memory.read(scope.sessionKey, "list");
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
  if (owner.kind === "incognito") {
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
  const options = { agentId: source.agentId, path: source.path, env: readScope.env };
  return {
    kind: "file",
    source,
    assertSourceCurrent: assertLogicalSourceCurrent,
    async readCurrent() {
      const entry = await withSessionHistoryWorkerDatabase(options, (reader) =>
        reader.readEntryCurrent({ scope: readScope, source }),
      );
      assertLogicalSourceCurrent();
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
    memoryRead?: ReturnType<typeof captureMemoryExactSessionReader>;
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
  const memoryRead = captureMemoryExactSessionReader(target);
  return Object.assign(params, {
    [runtimeAuthProfileExecution]: {
      target: { ...target },
      memoryRead,
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
  let entry: SessionEntry | undefined;
  if (binding.memoryRead) {
    binding.memoryRead.assertCurrent();
    entry = binding.memoryRead.read(binding.target.sessionKey, "list");
  } else {
    const { readSessionEntryInWorker, withSessionEntryReadOnlyInWorker } =
      await import("./session-entry-read-runtime.js");
    assertCurrent();
    const target = {
      ...binding.target,
      readConsistency: "latest" as const,
      hydrateSkillPromptRefs: false,
    };
    entry =
      binding.readMode === "read-only"
        ? await withSessionEntryReadOnlyInWorker(target, assertCurrent, async (read) => {
            if (!read.ok) {
              throw read.error;
            }
            return read.value;
          })
        : await readSessionEntryInWorker(target, assertCurrent);
  }
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
    const refusal = new Error(
      "Session account pin changed during preparation; retry with the current account.",
    );
    recordModelFallbackStop(refusal);
    throw refusal;
  }
}
