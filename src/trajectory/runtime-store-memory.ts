import {
  getSessionActorStorageBinding,
  type captureSessionActorStorageOwner,
} from "../config/sessions/session-actor-storage-binding.js";
import { IncognitoSessionMissingError } from "../state/incognito-session-error.js";
import type { SqliteTrajectoryRuntimeAppend } from "./runtime-store.contract.js";
import type { TrajectoryEvent } from "./types.js";

/** The runtime owns opt-in; this sink only queues its already-approved bounded events. */
export function createMemoryTrajectoryRuntimeSink(
  source: NonNullable<ReturnType<typeof captureSessionActorStorageOwner>>,
  params: {
    sessionId: string;
    sessionKey?: string;
    maxRuntimeFileBytes: number;
    assertCommitAllowed?: () => void;
  },
) {
  const { authority } = source;
  const sessionKey =
    params.sessionKey ??
    source.owner?.readSessionById(params.sessionId, authority)?.sessionKey ??
    source.binding?.actor.target.sessionKey;
  const selected = () => {
    const binding = getSessionActorStorageBinding({}) ?? source.binding;
    return binding?.agentId === source.agentId &&
      binding.path === source.path &&
      binding.actor.target.sessionKey === sessionKey
      ? binding
      : undefined;
  };
  const bound = selected();
  const current = bound
    ? bound.actor.snapshot(authority)
    : sessionKey
      ? source.owner?.readSession(sessionKey, authority)
      : undefined;
  if (current?.entry?.sessionId !== params.sessionId) {
    return null;
  }
  const append = async (input: SqliteTrajectoryRuntimeAppend) => {
    const binding = selected();
    const actor =
      binding?.actor ??
      (sessionKey
        ? await source.owner?.acquireExisting(sessionKey, {
            assertCurrent: authority.assertCurrent,
            assertReadable: authority.assertCurrent,
          })
        : undefined);
    if (!actor) {
      throw new IncognitoSessionMissingError();
    }
    try {
      return await actor.storage!.mutate({ type: "session.trajectory.append", input }, authority);
    } finally {
      if (!binding) {
        await actor.release();
      }
    }
  };
  let pending = new Map<TrajectoryEvent, number>();
  let queuedBytes = 0;
  let discardPrevious = false;
  let flushing: Promise<void> | undefined;
  let backgroundFailed = false;
  const trim = () => {
    while (queuedBytes > params.maxRuntimeFileBytes && pending.size > 1) {
      const [event, bytes] = pending.entries().next().value!;
      pending.delete(event);
      queuedBytes -= bytes;
      discardPrevious = true;
    }
  };
  const flush = (): Promise<void> => {
    if (flushing) {
      return flushing.then(flush);
    }
    if (pending.size === 0) {
      return Promise.resolve();
    }
    const batch = pending;
    const batchBytes = queuedBytes;
    const batchDiscard = discardPrevious;
    pending = new Map();
    queuedBytes = 0;
    discardPrevious = false;
    flushing = append({
      sessionId: params.sessionId,
      events: [...batch.keys()],
      discardPrevious: batchDiscard,
      maxRuntimeBytes: params.maxRuntimeFileBytes,
    })
      .then((result) => {
        if (result.kind === "rolled-back") {
          throw new Error(result.error.message);
        }
      })
      .catch((error: unknown) => {
        if (!discardPrevious) {
          pending = new Map([...batch, ...pending]);
          queuedBytes += batchBytes;
          discardPrevious = batchDiscard;
          trim();
        }
        throw error;
      })
      .finally(() => {
        flushing = undefined;
      });
    return flushing;
  };
  return {
    describeFlushState: () =>
      pending.size || flushing
        ? `pendingRows=${pending.size} queuedBytes=${queuedBytes} activeOperation=memory-append`
        : undefined,
    flush: async () => {
      backgroundFailed = false;
      await flush();
    },
    write(event: TrajectoryEvent, line: string) {
      const bytes = Buffer.byteLength(line) + 1;
      queuedBytes -= pending.get(event) ?? 0;
      pending.set(event, bytes);
      queuedBytes += bytes;
      trim();
      if (!flushing && !backgroundFailed && (pending.size >= 32 || queuedBytes >= 256 * 1024)) {
        void flush().catch(() => {
          backgroundFailed = true;
        });
      }
    },
  };
}
