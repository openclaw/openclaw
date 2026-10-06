import { randomUUID } from "node:crypto";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
  type SqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import type { IncognitoSessionActor } from "../config/sessions/session-incognito-actor.js";
import { captureIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import type {
  IncognitoComputeOperations,
  IncognitoComputeTarget,
  IncognitoComputeInstance,
} from "../config/sessions/session-incognito-compute-contract.js";
import type { IncognitoComputeScope } from "../config/sessions/session-incognito-compute.js";
import type {
  IncognitoSessionAuthority,
  IncognitoSessionFacts,
} from "../config/sessions/session-incognito-contract.js";
import { getAsyncWorkSignal, runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import type { SessionCostUsageRollupSnapshot } from "./session-cost-usage-cache.kernel.js";
import type { UsageCostWorkerHostRequest } from "./session-cost-usage-worker.types.js";

export type UsageCostIncognitoBinding = {
  actor: IncognitoSessionActor;
  authority: IncognitoSessionAuthority;
  target?: IncognitoComputeTarget;
  retainSource?: (sessionKey: string) => void;
  admissionSignal?: AbortSignal;
};

/**
 * Captures only an explicitly selected private store; aggregate durable discovery stays durable.
 * @internal P7 inactive composition; retain the Knip production exception until atomic activation.
 */
export function captureUsageCostIncognitoBinding(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  storePath?: string;
  sessionFile?: string;
  sessionFiles?: readonly string[];
  sessionTarget?: { agentId: string; storePath: string; sessionKey: string };
  incognito?: UsageCostIncognitoBinding;
}): UsageCostIncognitoBinding | undefined {
  if (params.incognito) {
    return params.incognito;
  }
  const targets = [
    ...(params.sessionTarget ? [params.sessionTarget] : []),
    ...[params.sessionFile, ...(params.sessionFiles ?? [])].flatMap((file) => {
      const marker = parseSqliteSessionFileMarker(file);
      return marker ? [marker] : [];
    }),
    {
      agentId: params.agentId,
      env: params.env,
      storePath: params.storePath ?? params.databasePath,
    },
  ];
  for (const target of targets) {
    const binding = captureIncognitoSessionBinding(target);
    if (binding) {
      return {
        actor: binding.actor,
        authority: { assertCurrent: () => binding.actor.assertReadable() },
        admissionSignal: binding.admissionSignal,
      };
    }
  }
  return undefined;
}

/**
 * Observations start at FIFO read acceptance and survive compute cleanup without recapture.
 * @internal P7 inactive composition; retain the Knip production exception until atomic activation.
 */
export function createUsageCostIncognitoReadObservation(binding: UsageCostIncognitoBinding) {
  const observations = new Map<
    string,
    {
      claim: ReturnType<typeof binding.actor.sessions.captureCurrent>;
      snapshot: ReturnType<typeof binding.actor.sessions.captureSnapshot>;
    }
  >();
  return {
    onRead: (facts: readonly IncognitoSessionFacts[]) => {
      for (const { sessionKey } of facts) {
        const observed = observations.get(sessionKey);
        if (observed) {
          observed.snapshot.assertCurrent();
        } else {
          observations.set(sessionKey, {
            claim: binding.actor.sessions.captureCurrent(sessionKey),
            snapshot: binding.actor.sessions.captureSnapshot(sessionKey),
          });
        }
      }
    },
    assertCurrent: () => {
      binding.actor.assertReadable();
      binding.authority.assertCurrent();
      binding.admissionSignal?.throwIfAborted();
      getAsyncWorkSignal()?.throwIfAborted();
      observations.forEach(({ claim, snapshot }) => {
        claim.authorize(binding.authority, "commit");
        snapshot.assertCurrent();
      });
    },
  };
}

export function withUsageCostIncognitoScope<T>(
  binding: UsageCostIncognitoBinding | undefined,
  operation: (binding?: UsageCostIncognitoBinding) => Promise<T>,
  settleAccepted = false,
): Promise<T> {
  if (!binding) {
    return operation();
  }
  getAsyncWorkSignal()?.throwIfAborted();
  binding.admissionSignal?.throwIfAborted();
  const { actor, authority } = binding;
  const target = structuredClone(binding.target);
  const claims = new Map<string, ReturnType<typeof actor.sessions.captureCurrent>>();
  const retainSource = (sessionKey: string) => {
    claims.set(sessionKey, claims.get(sessionKey) ?? actor.sessions.captureCurrent(sessionKey));
    binding.retainSource?.(sessionKey);
  };
  if (target) {
    retainSource(target.sessionKey);
  }
  const assertCurrent = () => {
    actor.assertCurrent();
    authority.assertCurrent();
    if (!settleAccepted) {
      binding.admissionSignal?.throwIfAborted();
    }
  };
  assertCurrent();
  return actor.sessions.withSharedState(() =>
    runOutsideAsyncWorkScope(async () => {
      const result = await operation({
        actor,
        admissionSignal: binding.admissionSignal,
        target,
        retainSource,
        authority: {
          assertCurrent,
          authorize: (stage, facts) => authority.authorize?.(stage, facts),
        },
      });
      assertCurrent();
      // Native grants use transaction-local facts; retained snapshots gate disclosure.
      claims.forEach((claim) => claim.authorize(authority, "commit"));
      return result;
    }),
  );
}

export async function readIncognitoUsageTranscript(
  binding: UsageCostIncognitoBinding,
  marker: SqliteSessionFileMarker,
): Promise<unknown[]> {
  const { actor, authority } = binding;
  const selected = structuredClone(binding.target);
  if (
    marker.agentId !== actor.agentId ||
    marker.storePath !== actor.path ||
    (selected && marker.sessionId !== selected.sessionId)
  ) {
    throw new Error("Usage transcript belongs to another actor session");
  }
  return actor.sessions.withCompute(
    authority,
    selected,
    async (compute) => {
      const target =
        selected ??
        (
          await compute.execute({
            type: "session.compute.store.inventory",
            input: {},
          })
        ).find((entry) => entry.sessionId === marker.sessionId);
      if (!target) {
        throw new Error("Usage incognito transcript is no longer available");
      }
      binding.retainSource?.(target.sessionKey);
      const sourceId = randomUUID();
      await compute.execute({
        type: "session.compute.source.open",
        input: { ...target, sourceId },
      });
      const events: unknown[] = [];
      let chunks: Uint8Array[] = [];
      for (;;) {
        const frame = await compute.execute({
          type: "session.compute.source.read",
          input: { ...target, sourceId },
        });
        if (frame.type === "source-unavailable") {
          throw new Error("Usage incognito transcript changed while reading");
        }
        if (frame.type === "source-end") {
          return events;
        }
        chunks.push(frame.bytes);
        if (frame.final) {
          events.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          chunks = [];
        }
      }
    },
    getAsyncWorkSignal(),
  );
}

/** Explicit inactive routing; physical identity and cleanup belong to the captured actor. */
export function createIncognitoUsageCostAdapter(
  compute: IncognitoComputeScope,
  target: IncognitoComputeTarget | undefined,
  marker: Pick<SqliteSessionFileMarker, "agentId" | "storePath">,
  instances: IncognitoComputeInstance[],
) {
  const selected = new Map(
    instances.map((entry) => [
      formatSqliteSessionFileMarker({ ...marker, sessionId: entry.sessionId }),
      entry,
    ]),
  );
  const filePaths = [...selected.keys()];
  const sources = new Map<string, string>();
  const assertMarker = (input: SqliteSessionFileMarker) => {
    const entry = selected.get(formatSqliteSessionFileMarker(input));
    if (!entry) {
      throw new Error("Usage worker requested another incognito session");
    }
    return entry;
  };
  const startedAt = Date.now();
  const lockJson = JSON.stringify({ pid: process.pid, startedAt, ownerNonce: randomUUID() });
  return {
    owns: (agentId: string, storePath: string) =>
      agentId === marker.agentId && storePath === marker.storePath,
    filePaths,
    assertCurrent: compute.assertCurrent,
    lock: {
      async acquire() {
        const previousRaw = await compute.execute(
          target
            ? {
                type: "session.compute.usage.refreshLock",
                input: { ...target, request: {} },
              }
            : { type: "session.compute.store.refreshLock", input: { request: {} } },
        );
        const request = {
          previousRaw,
          previousOwnerIsRunning: previousRaw !== null,
          lockJson,
          startedAt,
        };
        return compute.execute(
          target
            ? {
                type: "session.compute.usage.acquireLock",
                input: { ...target, request },
              }
            : { type: "session.compute.store.acquireLock", input: { request } },
        );
      },
      writeRollup(
        request: IncognitoComputeOperations["session.compute.usage.writeRollup"]["input"]["request"],
      ) {
        return compute.execute(
          target
            ? {
                type: "session.compute.usage.writeRollup",
                input: { ...target, request },
              }
            : { type: "session.compute.store.writeRollup", input: { request } },
        );
      },
      pruneRows(request: readonly SessionCostUsageRollupSnapshot[]) {
        return compute.execute(
          target
            ? {
                type: "session.compute.usage.prune",
                input: { ...target, request },
              }
            : { type: "session.compute.store.prune", input: { request } },
        );
      },
    },
    async read(request: UsageCostWorkerHostRequest) {
      switch (request.kind) {
        case "memory-instances":
          if (
            request.input.agentId !== marker.agentId ||
            request.input.storePath !== marker.storePath
          ) {
            throw new Error("Usage inventory belongs to another actor");
          }
          return instances.map(({ sessionId, updatedAtMs }) => ({
            agentId: marker.agentId,
            sessionId,
            updatedAtMs,
          }));
        case "memory-stats":
          return Promise.all(
            request.input.map((input) => {
              const selectedTarget = assertMarker(input);
              return compute.execute({
                type: "session.compute.usage.stats",
                input: { ...selectedTarget, request: {} },
              });
            }),
          );
        case "memory-cache":
          return compute.execute(
            target
              ? {
                  type: "session.compute.usage.cache",
                  input: {
                    ...target,
                    request: { filePaths: request.input.filePaths ?? filePaths },
                  },
                }
              : {
                  type: "session.compute.store.cache",
                  input: { request: { filePaths: request.input.filePaths ?? filePaths } },
                },
          );
        case "memory-cache-body":
          return compute.execute(
            target
              ? {
                  type: "session.compute.usage.cacheBody",
                  input: { ...target, request: request.input },
                }
              : { type: "session.compute.store.cacheBody", input: { request: request.input } },
          );
        case "memory-transcript": {
          const selectedTarget = assertMarker(request.input.marker);
          const key = JSON.stringify(request.input);
          let sourceId = sources.get(key);
          if (!sourceId) {
            sourceId = randomUUID();
            await compute.execute({
              type: "session.compute.source.open",
              input: { ...selectedTarget, sourceId, range: request.input },
            });
            sources.set(key, sourceId);
          }
          return compute.execute({
            type: "session.compute.source.read",
            input: { ...selectedTarget, sourceId },
          });
        }
        default:
          throw new Error("Invalid incognito usage read request");
      }
    },
  };
}
