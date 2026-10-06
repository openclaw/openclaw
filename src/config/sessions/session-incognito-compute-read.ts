import path from "node:path";
import type { BuildSessionEntryOptions } from "../../../packages/memory-host-sdk/src/host/session-files.js";
import type {
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import type { SessionTranscriptReadScope } from "./session-accessor.types.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type {
  IncognitoContextReadResult,
  IncognitoHistoryTarget,
} from "./session-incognito-history-contract.js";
import { createSessionTranscriptContextReader } from "./session-transcript-context-reader.js";
import { prepareIncognitoSessionTranscriptHydration } from "./session-transcript-hydration.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";

async function readContextResult<Value>(
  result: Promise<IncognitoContextReadResult<Value>>,
): Promise<Value> {
  const settled = await result;
  if (!settled.ok) {
    throw new SessionTranscriptReadFenceError(settled.message);
  }
  return settled.value;
}

/** Inactive adapters retain one actor; P7 supplies them to the production owners. */
export function bindIncognitoSessionComputeReader(params: {
  actor: IncognitoSessionActor;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget;
  signal?: AbortSignal;
}) {
  const { actor, authority, signal } = params;
  actor.assertCurrent();
  authority.assertCurrent();
  const target = structuredClone(params.target);
  const identity = { ...target, agentId: actor.agentId, storePath: actor.path };
  const claim = actor.sessions.captureCurrent(target.sessionKey);
  const disclose = () => {
    signal?.throwIfAborted();
    claim.authorize(authority, "commit");
    actor.assertReadable();
  };
  const assertScope = (scope: Partial<SessionTranscriptReadScope>) => {
    disclose();
    if (
      (scope.sessionId !== undefined && scope.sessionId !== target.sessionId) ||
      (scope.sessionKey !== undefined && scope.sessionKey !== target.sessionKey) ||
      (scope.agentId !== undefined && scope.agentId !== actor.agentId) ||
      (scope.storePath !== undefined && path.resolve(scope.storePath) !== actor.path)
    ) {
      throw new Error("Incognito compute read belongs to another session or store");
    }
  };
  const retain = <T>(operation: () => Promise<T>) =>
    actor.sessions.withCompute(authority, target, operation, signal).then((result) => {
      disclose();
      return result;
    });
  return {
    prepareHydration(
      limits?: Parameters<typeof prepareIncognitoSessionTranscriptHydration>[0]["limits"],
    ) {
      disclose();
      return prepareIncognitoSessionTranscriptHydration({
        actor,
        authority: {
          assertCurrent: disclose,
          authorize: (stage, facts) => authority.authorize?.(stage, facts),
        },
        target,
        limits,
        signal,
      });
    },
    memoryEntry(absPath: string, options: BuildSessionEntryOptions = {}) {
      const { onTranscriptMessage, ...serializable } = options;
      const captured = structuredClone(serializable);
      assertScope(captured);
      return retain(async () => {
        let source: ReturnType<typeof actor.sessions.captureSnapshot> | undefined;
        const snapshot = await actor.sessions.history(
          authority,
          {
            type: "session.history.memory-entry",
            input: { ...target, includeMessages: Boolean(onTranscriptMessage) },
          },
          signal,
          () => {
            source = actor.sessions.captureSnapshot(target.sessionKey);
          },
        );
        const { buildSessionEntryFromSnapshot } =
          await import("../../../packages/memory-host-sdk/src/host/session-files.js");
        return buildSessionEntryFromSnapshot(
          absPath,
          { ...captured, ...identity, onTranscriptMessage },
          snapshot,
          () => {
            disclose();
            if (!source) {
              throw new Error("Incognito Memory snapshot was not acknowledged");
            }
            source.assertCurrent();
          },
        );
      });
    },
    memoryCorpus(scope: SessionTranscriptCorpusScope, options: SessionTranscriptCorpusOptions) {
      const captured = structuredClone({ scope, options });
      disclose();
      return retain(async () => {
        const { readIncognitoMemoryCorpus } = await import("./session-incognito-memory-corpus.js");
        return readIncognitoMemoryCorpus(
          { actor, authority, target },
          captured.scope,
          captured.options,
          signal,
        );
      });
    },
    memoryResetRecall(scope: Partial<SessionTranscriptReadScope> = {}) {
      assertScope(scope);
      return retain(async () => {
        const cutoff = await actor.sessions.history(
          authority,
          {
            type: "session.history.memory-reset-recall",
            input: target,
          },
          signal,
        );
        disclose();
        return cutoff;
      });
    },
    nativeContext: createSessionTranscriptContextReader({
      assertCurrent: assertScope,
      read: () =>
        readContextResult(
          actor.sessions.history(
            authority,
            {
              type: "session.history.native-context",
              input: target,
            },
            signal,
          ),
        ),
      validate: ({ version }) =>
        readContextResult(
          actor.sessions.history(
            authority,
            {
              type: "session.history.native-context-current",
              input: { ...target, version },
            },
            signal,
          ),
        ),
      retain,
    }),
  };
}
