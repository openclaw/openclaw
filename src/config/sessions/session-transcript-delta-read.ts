import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import type {
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadScope,
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
} from "./session-accessor.sqlite-contract.js";
import { toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
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
  const memory = captureSessionActorTranscriptRead(scope, signal);
  if (memory) {
    let active = true;
    const assertActive = () => {
      signal?.throwIfAborted();
      if (!active) {
        throw new Error("Transcript delta reader is no longer active");
      }
    };
    try {
      const result = await consume({
        raw: async (limits) => {
          assertActive();
          if (memory.missing) {
            memory.assertCurrent();
            return { kind: "missing" };
          }
          return memory.read("session.history.raw-delta", { limits });
        },
        visible: async (limits) => {
          assertActive();
          if (memory.missing) {
            memory.assertCurrent();
            return { kind: "missing" };
          }
          return memory.read("session.history.visible-delta", { limits });
        },
      });
      assertActive();
      return result;
    } finally {
      active = false;
    }
  }
  let active = true;
  const assertActive = () => {
    signal?.throwIfAborted();
    if (!active) {
      throw new Error("Transcript delta reader is no longer active");
    }
  };
  try {
    return await withSessionTranscriptReadSource(
      scope,
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
