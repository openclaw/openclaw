import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { readSessionTranscriptVisibleMessageDeltaCore } from "./session-accessor.sqlite-active-events.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadScope,
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
} from "./session-accessor.sqlite-contract.js";
import { readTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import {
  captureIncognitoSessionHistoryBinding,
  captureIncognitoSessionSource,
} from "./session-incognito-binding.js";
import { prepareIncognitoSessionHistoryRead } from "./session-incognito-history-read.js";
import { isSessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";

type SessionTranscriptDeltaReader = {
  raw: (limits: SessionTranscriptRawDeltaLimits) => Promise<SessionTranscriptRawDeltaResult>;
  visible: (
    limits: SessionTranscriptVisibleMessageDeltaLimits,
  ) => Promise<SessionTranscriptVisibleMessageDeltaResult>;
};

/** Retain one physical reader across delta pages, cold restoration, and consumption. */
export async function withSessionTranscriptDeltaReader<T>(
  scope: SessionTranscriptReadScope,
  consume: (reader: SessionTranscriptDeltaReader) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const receipt = resolveSessionTranscriptReadFence({
    agentId: normalizeAgentId(
      scope.agentId ?? parseAgentSessionKey(scope.sessionKey)?.agentId ?? scope.defaultAgentId,
    ),
    sessionId: scope.sessionId,
  });
  const admission = receipt && structuredClone(receipt);
  const incognitoSource = captureIncognitoSessionSource(scope);
  const absent = incognitoSource && "kind" in incognitoSource ? incognitoSource : undefined;
  const incognito = absent ? undefined : captureIncognitoSessionHistoryBinding(scope);
  let active = true;
  const assertActive = () => {
    signal?.throwIfAborted();
    if (!active) {
      throw new Error("Transcript delta reader is no longer active");
    }
  };
  try {
    if (absent) {
      const missing = async (): Promise<{ kind: "missing" }> => {
        assertActive();
        absent.assertCurrent();
        return { kind: "missing" };
      };
      const result = await consume({ raw: missing, visible: missing });
      assertActive();
      absent.assertCurrent();
      return result;
    }
    if (incognito) {
      const prepared = prepareIncognitoSessionHistoryRead(incognito, scope, signal);
      const read = async <Value>(operation: () => Promise<Value>) => {
        assertActive();
        prepared.authority.assertCurrent();
        const value = await operation();
        prepared.authority.assertCurrent();
        assertActive();
        return value;
      };
      const result = await prepared.actor.sessions.withSharedState(() =>
        consume({
          raw: (limits) =>
            read(() =>
              prepared.actor.sessions.history(
                prepared.authority,
                {
                  type: "session.history.raw-delta",
                  input: { ...prepared.target, limits },
                },
                signal,
              ),
            ),
          visible: (limits) =>
            read(() =>
              prepared.actor.sessions.history(
                prepared.authority,
                {
                  type: "session.history.visible-delta",
                  input: { ...prepared.target, limits },
                },
                signal,
              ),
            ),
        }),
      );
      prepared.authority.assertCurrent();
      return result;
    }
    return await withSessionTranscriptReadSource(
      scope,
      async (captured) =>
        consume({
          // Process-held incognito retains its native owner until atomic activation.
          raw: async (limits) => {
            assertActive();
            return readTranscriptRawDelta(captured, limits);
          },
          visible: async (limits) => {
            assertActive();
            return readSessionTranscriptVisibleMessageDeltaCore(captured, limits);
          },
        }),
      async (source) => {
        const reader = source.preparedReads ?? source.owner;
        const assertCurrent = () => {
          assertActive();
          source.assertCurrent();
        };
        const read = async <Value>(operation: () => Promise<Value>) => {
          assertCurrent();
          const value = await readRestoredSessionTranscript(source.scope, operation, {
            assertCurrent,
            coldRead: {
              target: source.resolved,
              readMetadata: async () =>
                (
                  await reader.readColdMetadata({
                    sessionId: source.resolved.sessionId,
                    env: source.scope.env,
                  })
                ).archive,
            },
          });
          assertCurrent();
          return value;
        };
        if (!source.expectedIdentity) {
          return consume({
            raw: async () => {
              assertCurrent();
              return { kind: "missing" };
            },
            visible: async () => {
              assertCurrent();
              return { kind: "missing" };
            },
          });
        }
        const request = {
          scope: source.scope,
          resolved: source.resolved,
          admission,
          expectedIdentity: source.expectedIdentity,
        };
        return consume({
          raw: (limits) =>
            read(() => reader.readRawDelta({ ...request, limits: { ...limits } }, signal)),
          visible: (limits) =>
            read(async () => {
              try {
                return await reader.readVisibleDelta({ ...request, limits: { ...limits } }, signal);
              } catch (error) {
                if (isSessionTranscriptProjectionUnavailableError(error)) {
                  assertCurrent();
                  startSessionTranscriptIndexReconcile({
                    ...toDatabaseOptions(source.resolved),
                    preferredSessionId: source.resolved.sessionId,
                  });
                }
                throw error;
              }
            }),
        });
      },
      signal,
    );
  } finally {
    active = false;
  }
}
