import { isDeepStrictEqual } from "node:util";
import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent-runner/runs.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadExactSessionEntryFromStoreReadOnly } from "../config/sessions/session-accessor.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntriesFromStoresInWorker,
} from "../config/sessions/session-entry-read-runtime.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { isSessionWorkAdmissionActive } from "../sessions/session-lifecycle-admission.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import type {
  CreatedGatewaySession,
  CreateGatewaySessionParams,
} from "./session-create-service.types.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { invalidSessionRequest, unavailableSessionRequest } from "./session-request-error.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

type SessionCreateSourceResult = Result<
  {
    incognitoStorePath?: string;
    boundInitialEntry?: InternalSessionEntry;
    commitGuard: CreateGatewaySessionParams["commitGuard"];
  },
  ErrorShape
>;

/** Capture the private source before asynchronous creation preparation can change its owner. */
export function prepareSessionCreateSource(
  params: CreateGatewaySessionParams,
  agentId: string,
  explicitTargetKey: string | undefined,
  commitGuard: CreateGatewaySessionParams["commitGuard"],
): SessionCreateSourceResult | Promise<SessionCreateSourceResult> {
  const explicitIncognito = isIncognitoSessionKey(explicitTargetKey);
  const incognitoSource = explicitIncognito
    ? captureIncognitoSessionSource({ agentId, sessionKey: explicitTargetKey })
    : params.incognito === true
      ? captureIncognitoSessionSource()
      : undefined;
  const source =
    incognitoSource && ("kind" in incognitoSource ? incognitoSource : incognitoSource.actor);
  if (incognitoSource && source) {
    if (source.agentId !== agentId) {
      return invalidSessionRequest("session creation belongs to another incognito actor");
    }
    const assertCallerCurrent = commitGuard;
    commitGuard = () => {
      assertCallerCurrent?.();
      incognitoSource.admissionSignal?.throwIfAborted();
      source.assertCurrent();
    };
  }
  const explicitTargetParts = parseAgentSessionKey(explicitTargetKey);
  const explicitDashboardIncognito =
    explicitIncognito &&
    explicitTargetParts?.agentId === agentId &&
    explicitTargetParts.rest.startsWith("dashboard:");
  if (explicitIncognito && params.incognito !== true) {
    return invalidSessionRequest("incognito-shaped session keys require incognito: true");
  }
  if (params.incognito === true && explicitTargetKey && !explicitDashboardIncognito) {
    return invalidSessionRequest("incognito sessions are web-only");
  }
  const finish = (
    boundInitialEntry: InternalSessionEntry | undefined,
  ): SessionCreateSourceResult => {
    if (params.incognito === true && explicitTargetKey) {
      const durableStorePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
      const durableEntry = incognitoSource
        ? undefined
        : loadExactSessionEntryFromStoreReadOnly({
            agentId,
            storePath: durableStorePath,
            sessionKey: explicitTargetKey,
            projection: "list",
          });
      const privateEntry = incognitoSource
        ? boundInitialEntry
        : loadGatewaySessionEntryReadOnly(explicitTargetKey).entry;
      if (durableEntry || privateEntry) {
        return invalidSessionRequest("incognito is immutable and requires a new session key");
      }
    }
    return {
      ok: true,
      value: { incognitoStorePath: source?.path, boundInitialEntry, commitGuard },
    };
  };
  return incognitoSource && explicitTargetKey
    ? readSessionEntryReadOnlyInWorker(
        { agentId, sessionKey: explicitTargetKey },
        commitGuard,
      ).then(finish)
    : finish(undefined);
}

// The caller holds target lifecycle custody from this reread through commit and rollback.
export async function readSessionCreateTarget(
  params: CreateGatewaySessionParams,
  target: GatewaySessionStoreTarget,
  expectedSessionId: string | undefined,
  lifecycleIdentities: readonly string[],
): Promise<Result<InternalSessionEntry | undefined, ErrorShape>> {
  const assertRoutingCurrent = captureSessionMutationRouting(params.cfg);
  const assertCurrent = () => {
    params.commitGuard?.();
    assertRoutingCurrent(params.getCurrentConfig?.() ?? params.cfg);
  };
  const validate = (
    currentTargetEntry: InternalSessionEntry | undefined,
  ): Result<InternalSessionEntry | undefined, ErrorShape> => {
    assertCurrent();
    // Lifecycle custody keeps this owner stable through naming and filesystem preparation.
    const existingOwnershipError = resolvePluginSessionOwnershipError({
      action: "adopt",
      entry: currentTargetEntry,
      key: target.canonicalKey,
      pluginOwnerId: params.authorizedPluginId,
    });
    if (existingOwnershipError) {
      return { ok: false, error: existingOwnershipError };
    }
    if (currentTargetEntry) {
      const requestedCwd = normalizeOptionalString(params.spawnedCwd);
      const requestedRoot = normalizeOptionalString(
        params.sessionRoot ?? params.defaultSessionRoot,
      );
      const requestedNode = normalizeOptionalString(params.execNode);
      const requestedExecCwd = normalizeOptionalString(params.execCwd);
      const changesFilesystemBinding =
        params.prepareLifecycle !== undefined ||
        (requestedCwd !== undefined && requestedCwd !== currentTargetEntry.spawnedCwd) ||
        (requestedRoot !== undefined && requestedRoot !== currentTargetEntry.sessionRoot) ||
        (requestedNode !== undefined &&
          (currentTargetEntry.execHost !== "node" ||
            requestedNode !== currentTargetEntry.execNode ||
            (requestedExecCwd !== undefined && requestedExecCwd !== currentTargetEntry.execCwd)));
      if (changesFilesystemBinding) {
        // The fence queues new work; it cannot move a checkout underneath an admitted turn.
        // Preparation can allocate before returning, so reject before invoking it.
        if (currentTargetEntry.sessionId !== expectedSessionId) {
          return unavailableSessionRequest(
            `Session ${target.canonicalKey} changed before workspace preparation; retry.`,
          );
        }
        if (
          isSessionWorkAdmissionActive(target.storePath, lifecycleIdentities) ||
          isEmbeddedAgentRunActive(currentTargetEntry.sessionId)
        ) {
          return unavailableSessionRequest(
            `Session ${target.canonicalKey} is still active; retry workspace preparation after its work finishes.`,
          );
        }
      }
    }
    if (!currentTargetEntry) {
      const creationError = authorizeGatewaySessionCreation({
        cfg: params.cfg,
        agentId: target.agentId,
        ...(params.operatorRoleActor
          ? { actor: params.operatorRoleActor }
          : { profileId: params.requestingOperatorProfileId }),
      });
      if (creationError) {
        return { ok: false, error: creationError };
      }
    }
    return { ok: true, value: currentTargetEntry };
  };
  assertCurrent();
  // Process-held incognito stores retain their native owner until its complete cutover.
  if (isIncognitoSessionKey(target.canonicalKey)) {
    if (
      captureIncognitoSessionSource({
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKey: target.canonicalKey,
      })
    ) {
      return validate(
        await readSessionEntryReadOnlyInWorker(
          { agentId: target.agentId, storePath: target.storePath, sessionKey: target.canonicalKey },
          assertCurrent,
        ),
      );
    }
    return validate(
      loadGatewaySessionEntryReadOnly(target.canonicalKey, { agentId: target.agentId }).entry,
    );
  }
  const result = await withSessionEntriesFromStoresInWorker(
    [
      {
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKeys: target.storeKeys,
        projection: "exact",
      },
    ],
    ([read]) => {
      read!.assertCurrent();
      const store = Object.fromEntries(
        read!.result.entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
      );
      return validate(findCanonicalStoreMatch(store, target.storeKeys)?.entry);
    },
    { ordered: true },
  );
  assertCurrent();
  return result;
}

export async function finalizeSessionCreateTarget(
  target: Pick<CreatedGatewaySession, "key" | "storePath">,
  expectedEntry: InternalSessionEntry,
  commitGuard: CreateGatewaySessionParams["commitGuard"],
): Promise<InternalSessionEntry> {
  const finalized = await patchSessionEntryCore(
    { sessionKey: target.key, storePath: target.storePath },
    (current) => {
      if (!isDeepStrictEqual(current, expectedEntry)) {
        throw new Error(`created session ${target.key} changed before finalization`);
      }
      return { initializationPending: undefined };
    },
    {
      preserveActivity: true,
      requireWriteSuccess: true,
      ...sessionEntryCommitGuardOptions(commitGuard),
    },
  );
  if (!finalized) {
    throw new Error(`created session ${target.key} disappeared before finalization`);
  }
  return finalized;
}
