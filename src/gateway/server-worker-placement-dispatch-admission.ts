import { isDeepStrictEqual } from "node:util";
import { getRuntimeConfig } from "../config/config.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { captureSessionEntryCurrentRead } from "../config/sessions/session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
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
import { registerOpenClawAgentDatabaseAsyncResource } from "../state/openclaw-agent-db-resources.js";
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
    authorize?: () => void;
    signal?: AbortSignal;
    retainEntryFields?: readonly (keyof SessionEntry)[];
  },
  run: (source: {
    target: { agentId: string; canonicalKey: string; storePath: string; storeKeys: string[] };
    entry: SessionEntry;
    assertCurrent: () => SessionEntry;
    signal: AbortSignal;
    onCommitted: () => void;
  }) => Promise<T>,
): Promise<T> {
  const getConfig = params.getConfig ?? getRuntimeConfig;
  const scope = params.identity;
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
  const assertRoutingCurrent = () => {
    // Stop cancels execution, not the authority to settle already-committed cleanup.
    // Caller revocation and source currency still fence every authorized side effect.
    params.signal?.throwIfAborted();
    params.authorize?.();
    if (resolveSessionStorePathForScope(scope, getConfig()) !== configuredRoute) {
      throw new WorkerPlacementAdmissionTargetError(
        "Session source changed during worker admission; retry.",
      );
    }
  };
  let admission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  const acquiring = new AbortController();
  const abortAcquisition = () => acquiring.abort(signal.reason);
  signal.addEventListener("abort", abortAcquisition, { once: true });
  try {
    // Reserve before asynchronous source acquisition so Stop can retire queued ingress.
    admission = await beginSessionWorkAdmission({
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
            acquiring.signal.throwIfAborted();
            assertRoutingCurrent();
          },
          async (read, owner) => {
            signal.throwIfAborted();
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
            const matches = (current: SessionEntry | undefined) =>
              Boolean(
                current &&
                current.sessionId === entry.sessionId &&
                current.lifecycleRevision === entry.lifecycleRevision &&
                current.archivedAt === undefined &&
                (params.retainEntryFields ?? []).every((field) =>
                  isDeepStrictEqual(current[field], entry[field]),
                ),
              );
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
              path: owner.scope?.storePath ?? owner.incognito?.actor.path ?? configuredPath,
              revoke: () => controller.abort(new Error("Worker session source was revoked")),
              close: () => completed.promise,
            });
            let active = true;
            const assertCurrent = () => {
              if (!active) {
                throw new WorkerPlacementAdmissionTargetError(
                  "Worker session admission scope was released.",
                );
              }
              assertRoutingCurrent();
              owner.assertCurrent();
              source.assertSourceCurrent();
              if (retained ? !retained.isCurrent() : changed) {
                throw new WorkerPlacementAdmissionTargetError(
                  "Session changed during worker admission; retry.",
                );
              }
              return entry;
            };
            const target = {
              agentId: scope.agentId,
              canonicalKey: scope.sessionKey,
              storePath: owner.scope?.storePath ?? owner.incognito?.actor.path ?? configuredPath,
              storeKeys: params.target?.storeKeys ?? [scope.sessionKey],
            };
            try {
              return await run({
                target,
                entry,
                assertCurrent,
                signal,
                onCommitted: () => {
                  acceptOwnPublication = true;
                },
              });
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
    signal?.throwIfAborted();
    authorize?.();
    const runtime = await loadSessionRuntime();
    const target = resolveWorkerPlacementSessionStoreTarget(runtime, getRuntimeConfig(), identity);
    const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys);
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
        expectedEntry: { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
        authorize,
        signal,
        retainEntryFields: ["agentRuntimeOverride", "execNode"],
      },
      (source) =>
        run(source.signal, () => {
          source.assertCurrent();
        }),
    );
  };
}
