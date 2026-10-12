import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfig } from "../config/config.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import {
  acquireSessionActorStorage,
  captureSessionActorStorageOwner,
  runWithSessionActorStorage,
} from "../config/sessions/session-actor-storage-binding.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { captureSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  prepareSessionRowPublicationScope,
  sessionChangeAffectsStoredRow,
} from "../sessions/session-row-facts.js";
import { createDeferredCore } from "../shared/deferred.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
import { retainGatewayDeviceRevocation } from "./device-revocation.js";
import {
  loadWorkerPlacementSessionRuntimeModule,
  resolveWorkerPlacementSessionStoreTarget,
  type WorkerPlacementSessionRuntime,
} from "./server-worker-placement-session-target.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";
import type { WorkerSessionPlacementIdentity } from "./worker-environments/placement-record.js";
import {
  WorkerPlacementAdmissionTargetError,
  type WorkerPlacementDispatchAdmission,
} from "./worker-environments/service-contract.js";

/** Session custody lasts through the consumer, including unsettled placement effects. */
export async function withGatewayWorkerSessionAdmission<T>(
  params: {
    identity: WorkerSessionPlacementIdentity;
    target?: Pick<
      GatewaySessionStoreTarget,
      "agentId" | "canonicalKey" | "storePath" | "storeKeys"
    >;
    expectedEntry?: Pick<SessionEntry, "sessionId" | "lifecycleRevision">;
    getConfig?: () => OpenClawConfig;
    authorize?: SessionSourceAssertion;
    signal?: AbortSignal;
    retainEntryFields?: readonly (keyof SessionEntry)[];
  },
  run: (source: {
    target: { agentId: string; canonicalKey: string; storePath: string; storeKeys: string[] };
    entry: SessionEntry;
    assertCurrent: (() => SessionEntry) & SessionSourceAssertion;
    signal: AbortSignal;
    onCommitted: () => void;
  }) => Promise<T>,
): Promise<T> {
  const getConfig = params.getConfig ?? getRuntimeConfig;
  const scope = params.identity;
  const assertCallerCurrent = () => {
    params.signal?.throwIfAborted();
    params.authorize?.();
  };
  const authority = { assertCurrent: assertCallerCurrent, authorize: assertCallerCurrent };
  const namespace = captureSessionActorStorageOwner(scope, authority);
  const memory =
    namespace &&
    (await acquireSessionActorStorage(scope, {
      authority,
      lifetime: { assertCurrent: assertCallerCurrent, assertReadable: assertCallerCurrent },
    }));
  if (namespace && !memory) {
    throw new WorkerPlacementAdmissionTargetError("Worker session source is unavailable; retry.");
  }
  if (memory) {
    try {
      const entry = memory.actor.snapshot(memory.authority)?.entry;
      if (
        !entry ||
        entry.sessionId !== scope.sessionId ||
        entry.archivedAt !== undefined ||
        (params.expectedEntry && entry.lifecycleRevision !== params.expectedEntry.lifecycleRevision)
      ) {
        throw new WorkerPlacementAdmissionTargetError(
          "Worker session source is unavailable; retry.",
        );
      }
      const fields = [
        ...new Set<keyof SessionEntry>([
          "sessionId",
          "lifecycleRevision",
          "archivedAt",
          ...(params.retainEntryFields ?? []),
        ]),
      ];
      const controller = new AbortController();
      const signal = params.signal
        ? AbortSignal.any([params.signal, controller.signal])
        : controller.signal;
      let active = true;
      const assertCurrent = () => {
        if (!active) {
          throw new WorkerPlacementAdmissionTargetError(
            "Worker session admission scope was released.",
          );
        }
        params.signal?.throwIfAborted();
        params.authorize?.();
        const current = memory.actor.snapshot(memory.authority)?.entry;
        if (!current || fields.some((field) => !isDeepStrictEqual(current[field], entry[field]))) {
          throw new WorkerPlacementAdmissionTargetError(
            "Session changed during worker admission; retry.",
          );
        }
        return current;
      };
      let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
      try {
        admission = await beginSessionWorkAdmission({
          scope: memory.path,
          identities: [scope.sessionKey, scope.sessionId, ...(params.target?.storeKeys ?? [])],
          onInterrupt: (reason) => controller.abort(reason),
          signal,
          assertAllowed: () => {
            assertCurrent();
          },
        });
        return await admission.run(() =>
          runWithSessionActorStorage(memory, () =>
            run({
              target: {
                agentId: memory.agentId,
                canonicalKey: scope.sessionKey,
                storePath: memory.path,
                storeKeys: params.target?.storeKeys ?? [scope.sessionKey],
              },
              entry,
              assertCurrent,
              signal,
              onCommitted: () => {},
            }),
          ),
        );
      } finally {
        active = false;
        admission?.release();
      }
    } finally {
      await memory.actor.release();
    }
  }
  const configuredRoute = resolveSessionStorePathForScope(scope, getConfig());
  const configuredPath = params.target?.storePath ?? configuredRoute;
  const binding = captureSessionTranscriptTargetBinding({ ...scope, storePath: configuredPath });
  const publication = prepareSessionRowPublicationScope([configuredPath]);
  let retained: ReturnType<typeof retainPreparedSessionEntryPredicate> | undefined;
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, controller.signal])
    : controller.signal;
  let changed = false;
  let acceptOwnPublication = false;
  const stopPublication = sessionChanges.subscribeFacts((change) => {
    if (
      sessionChangeAffectsStoredRow(change, {
        ...publication,
        agentId: scope.agentId,
        sessionKeys: [scope.sessionKey],
        ignoreStoreTopology: true,
      })
    ) {
      if (retained) {
        if (!retained.isCurrent()) {
          controller.abort(
            new WorkerPlacementAdmissionTargetError(
              "Session changed during worker admission; retry.",
            ),
          );
        }
      } else if (acceptOwnPublication) {
        acceptOwnPublication = false;
      } else {
        changed = true;
      }
    }
  });
  const assertRouteCurrent = () => {
    if (resolveSessionStorePathForScope(scope, getConfig()) !== configuredRoute) {
      throw new WorkerPlacementAdmissionTargetError(
        "Session source changed during worker admission; retry.",
      );
    }
  };
  const assertRoutingCurrent = () => {
    // Stop cancels execution, not the authority to settle already-committed cleanup.
    // Caller revocation and source currency still fence every authorized side effect.
    params.signal?.throwIfAborted();
    params.authorize?.();
    assertRouteCurrent();
  };
  let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  const acquiring = new AbortController();
  const abortAcquisition = () => acquiring.abort(signal.reason);
  signal.addEventListener("abort", abortAcquisition, { once: true });
  try {
    // Reserve before asynchronous source acquisition so Stop can retire queued ingress.
    admission = await beginSessionWorkAdmission({
      agentId: scope.agentId,
      scope: configuredPath,
      identities: [scope.sessionKey, scope.sessionId, ...(params.target?.storeKeys ?? [])],
      onInterrupt: (reason) => controller.abort(reason),
      signal,
      assertAllowed: assertRoutingCurrent,
    });
    return await admission.run(() =>
      racePromiseWithAbortSignal(
        withSessionEntryReadOnlyInWorker(
          binding,
          () => {
            // Prepared writes compose caller authority separately from the retained reader.
            acquiring.signal.throwIfAborted();
            params.signal?.throwIfAborted();
            assertRouteCurrent();
          },
          async (read, owner) => {
            signal.throwIfAborted();
            assertRoutingCurrent();
            // Once a consumer starts, cancellation cannot release its unsettled writes.
            signal.removeEventListener("abort", abortAcquisition);
            if (!read.ok) {
              throw read.error;
            }
            const entry = read.value;
            if (
              !entry ||
              entry.sessionId !== scope.sessionId ||
              entry.archivedAt !== undefined ||
              (params.expectedEntry &&
                (entry.sessionId !== params.expectedEntry.sessionId ||
                  entry.lifecycleRevision !== params.expectedEntry.lifecycleRevision)) ||
              changed
            ) {
              throw new WorkerPlacementAdmissionTargetError(
                "Worker session source is unavailable or changed during admission; retry.",
              );
            }
            const source = captureSessionEntryCurrentRead(binding, owner);
            const fields = [
              ...new Set<keyof SessionEntry>([
                "sessionId",
                "lifecycleRevision",
                "archivedAt",
                ...(params.retainEntryFields ?? []),
              ]),
            ];
            const selected: Partial<SessionEntry> = {};
            const captureField = <Key extends keyof SessionEntry>(
              field: Key,
              value: SessionEntry[Key],
            ) => {
              selected[field] = structuredClone(value);
            };
            fields.forEach((field) => captureField(field, entry[field]));
            const expected = freezeJsonSnapshot(selected);
            const matches = (current: SessionEntry | undefined) =>
              current !== undefined &&
              fields.every((field) => isDeepStrictEqual(current[field], expected[field]));
            retained =
              source.kind === "file"
                ? retainPreparedSessionEntryPredicate({
                    databaseIdentity: `file:${source.source.databaseIdentity}`,
                    sessionKey: scope.sessionKey,
                    entry,
                    matches: (_before, after) => matches(after),
                  })
                : undefined;
            // The canonical publication owner now fences the exact physical row. Workspace
            // binding may advance it without replacing the session or selected runtime.
            if (source.kind === "file") {
              publication.databaseIdentities.add(source.source.databaseIdentity);
            }
            const completed = createDeferredCore();
            const unregister = registerOpenClawAgentDatabaseAsyncResource({
              agentId: owner.scope?.databaseAgentId ?? scope.agentId,
              path: owner.scope?.storePath ?? configuredPath,
              revoke: () => controller.abort(new Error("Worker session source was revoked")),
              close: () => completed.promise,
            });
            let active = true;
            const assertActive = () => {
              if (!active) {
                throw new WorkerPlacementAdmissionTargetError(
                  "Worker session admission scope was released.",
                );
              }
            };
            const assertLocalCurrent = () => {
              assertActive();
              assertRouteCurrent();
              owner.assertCurrent();
              source.assertSourceCurrent();
              if (retained ? !retained.isCurrent() : changed) {
                throw new WorkerPlacementAdmissionTargetError(
                  "Session changed during worker admission; retry.",
                );
              }
            };
            const rowAuthority: SessionSourceAssertion = Object.assign(assertLocalCurrent, {
              nativeSource: source.kind === "native" || source.kind === "missing",
              async prepareSessionSource(): Promise<PreparedSessionSourceAuthority> {
                assertLocalCurrent();
                return {
                  nativeSource: source.kind === "native" || source.kind === "missing",
                  assertCurrent: assertLocalCurrent,
                  // The enclosing admission already retains this exact read and its lifetime.
                  checks:
                    source.kind === "file"
                      ? [
                          {
                            predicate: {
                              source: source.source,
                              sessionKey: source.source.sessionKey,
                              fields: [...fields],
                              expected,
                            },
                            refuse: () => {
                              throw new WorkerPlacementAdmissionTargetError(
                                "Session changed during worker admission; retry.",
                              );
                            },
                          },
                        ]
                      : [],
                };
              },
            });
            const assertion = composeSessionSourceAssertion(
              [params.authorize, rowAuthority],
              (assertSources) => {
                assertActive();
                params.signal?.throwIfAborted();
                assertSources();
              },
            );
            const assertCurrent: (() => SessionEntry) & SessionSourceAssertion =
              Object.defineProperty(
                Object.assign(
                  () => {
                    assertion();
                    return entry;
                  },
                  {
                    prepareSessionSource: async () => {
                      assertActive();
                      params.signal?.throwIfAborted();
                      return await prepareSessionSourceAuthority(assertion);
                    },
                  },
                ),
                "nativeSource",
                { enumerable: true, get: () => assertion.nativeSource },
              );
            const target = {
              agentId: scope.agentId,
              canonicalKey: scope.sessionKey,
              storePath: owner.scope?.storePath ?? configuredPath,
              storeKeys: params.target?.storeKeys ?? [scope.sessionKey],
            };
            try {
              const result = await run({
                target,
                entry,
                assertCurrent,
                signal,
                onCommitted: () => {
                  acceptOwnPublication = true;
                },
              });
              assertRoutingCurrent();
              return result;
            } finally {
              active = false;
              retained?.release();
              unregister();
              completed.resolve();
            }
          },
        ),
        acquiring.signal,
      ),
    );
  } finally {
    signal.removeEventListener("abort", abortAcquisition);
    admission?.release();
    stopPublication();
  }
}

export function createGatewayWorkerDispatchAdmission(
  loadSessionRuntime: () => Promise<WorkerPlacementSessionRuntime> = loadWorkerPlacementSessionRuntimeModule,
): WorkerPlacementDispatchAdmission {
  return async (identity, run, authorize, signal) => {
    // The requested acknowledgment can release the RPC while dispatch still owns setup.
    const releaseCaller = retainGatewayDeviceRevocation(authorize);
    try {
      const admit = async () => {
        // v2026.9.8 Gateway contexts accept opaque dispatch/move authorization callbacks.
        const sourceAuthorize = captureExternalSessionCommitGuard(authorize);
        signal?.throwIfAborted();
        sourceAuthorize?.();
        const runtime = await loadSessionRuntime();
        const target = resolveWorkerPlacementSessionStoreTarget(
          runtime,
          getRuntimeConfig(),
          identity,
        );
        const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(
          target.store,
          target.storeKeys,
        );
        if (
          !entry ||
          target.agentId !== identity.agentId ||
          target.canonicalKey !== identity.sessionKey
        ) {
          throw new WorkerPlacementAdmissionTargetError(
            "Worker dispatch lost its canonical session target; retry.",
          );
        }
        return await withGatewayWorkerSessionAdmission(
          {
            identity,
            target,
            expectedEntry: {
              sessionId: entry.sessionId,
              lifecycleRevision: entry.lifecycleRevision,
            },
            authorize: sourceAuthorize,
            signal,
            retainEntryFields: ["agentRuntimeOverride", "execNode"],
          },
          (source) => run(source.signal, source.assertCurrent),
        );
      };
      return await admit();
    } finally {
      releaseCaller?.();
    }
  };
}
