import { performance } from "node:perf_hooks";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import {
  type SessionRowPreparationOptions,
  type SessionRowReadView,
  withReadySessionRows,
} from "./session-row-prepared-read.js";
import type { Lookup } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const PUBLICATIONS_PER_TURN = 8;
const PUBLICATION_BUDGET_MS = 6;
const publicationOwners = new WeakMap<
  SessionRowProjection,
  ReturnType<typeof createPublicationOwner>
>();

function createPublicationOwner(projection: SessionRowProjection) {
  const pending = new Set<Promise<unknown>>();
  const deferred = Symbol("publication-deferred");
  let started = 0;
  let startedAt = 0;
  let reset: ReturnType<typeof setImmediate> | undefined;
  let wait: Promise<void> | undefined;
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }
  function claimTurn() {
    const now = performance.now();
    if (!reset) {
      started = 0;
      startedAt = now;
      reset = setImmediate(() => {
        reset = undefined;
      });
      reset.unref?.();
    }
    if (wait || started >= PUBLICATIONS_PER_TURN || now - startedAt >= PUBLICATION_BUDGET_MS) {
      // Yield from exhaustion: the earlier reset may precede newly queued I/O.
      return (wait ??= new Promise<void>((resolve) => {
        setImmediate(() => {
          wait = undefined;
          resolve();
        });
      }));
    }
    started++;
    return undefined;
  }
  const rows: Pick<SessionRowProjection, "withPreparedExactRows"> = {
    withPreparedExactRows(queries, consume, options) {
      return track(
        (async () => {
          for (;;) {
            let yieldUntil: Promise<void> | undefined;
            const prepared = await projection.withPreparedExactRows(
              queries,
              (read) => {
                yieldUntil = claimTurn();
                return yieldUntil ? deferred : consume(read);
              },
              options,
            );
            if (prepared.kind === "pending") {
              return prepared;
            }
            if (prepared.value !== deferred) {
              return { kind: "complete" as const, value: prepared.value };
            }
            // Prepared views expire synchronously; reacquire facts and authority after yielding.
            await yieldUntil;
          }
        })(),
      );
    },
  };
  return {
    rows: {
      ...rows,
      withReadyRows<T>(
        queries: (config: SessionRowReadView["state"]["cfg"]) => readonly Lookup[],
        consume: (read: SessionRowReadView) => T,
        options?: SessionRowPreparationOptions,
      ) {
        return track(withReadySessionRows(rows, queries, consume, options));
      },
    },
    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled(pending);
      }
      clearImmediate(reset);
      reset = undefined;
    },
  };
}

/** Independent prepared publishers share a budget without serializing row preparation. */
export function sessionEventPublicationRows(projection: SessionRowProjection) {
  let owner = publicationOwners.get(projection);
  if (!owner) {
    owner = createPublicationOwner(projection);
    publicationOwners.set(projection, owner);
  }
  return owner.rows;
}

export async function drainSessionEventPublications(projection: SessionRowProjection) {
  await publicationOwners.get(projection)?.drain();
}

export async function withPreparedSessionEventRow(
  projection: SessionRowProjection | undefined,
  sessionKey: string,
  eventAgentId: string | undefined,
  publish: () => void,
) {
  if (!projection) {
    publish();
    return;
  }
  const routingAgentId = resolveSessionEventAgentScope(
    getRuntimeConfig(),
    sessionKey,
    eventAgentId,
  )?.[1];
  if (routingAgentId) {
    await sessionEventPublicationRows(projection).withReadyRows(
      () => [{ key: sessionKey, agentId: routingAgentId }],
      () => publish(),
      { includeAncestors: true },
    );
    return;
  }
  do {
    await projection.ensureMaterialized();
  } while (projection.needsMaterialization);
  publish();
}
