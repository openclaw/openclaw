import { isDeepStrictEqual } from "node:util";
import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ErrorShape } from "../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent-runner/runs.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import {
  readSessionEntriesFromStoreInWorker,
  withSessionEntriesFromStoresInWorker,
} from "../config/sessions/session-entry-read-runtime.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import {
  beginSessionWorkAdmission,
  isSessionWorkAdmissionActive,
} from "../sessions/session-lifecycle-admission.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import type {
  CreatedGatewaySession,
  CreateGatewaySessionParams,
  CreateGatewaySessionResult,
} from "./session-create-service.types.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { resolveSessionCreateAgentId } from "./session-request-agent.js";
import { invalidSessionRequest, unavailableSessionRequest } from "./session-request-error.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnlyInWorker } from "./session-utils-store-worker.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

/** Select and retain the agent's admission through creation, finalization, and rollback. */
export async function withSessionCreateAdmission(
  params: CreateGatewaySessionParams,
  create: (
    params: CreateGatewaySessionParams,
    agentId: string,
  ) => Promise<CreateGatewaySessionResult>,
): Promise<CreateGatewaySessionResult> {
  const selectedAgent = resolveSessionCreateAgentId(params.cfg, {
    key: normalizeOptionalString(params.key),
    agentId: params.agentId,
    parentSessionKey: normalizeOptionalString(params.parentSessionKey),
  });
  if (!selectedAgent.ok) {
    return selectedAgent;
  }
  const interrupted = new AbortController();
  const assertCurrent = () => {
    interrupted.signal.throwIfAborted();
    params.commitGuard?.();
  };
  const admission = await beginSessionWorkAdmission({
    agentId: selectedAgent.agentId,
    scope: `agent:${selectedAgent.agentId}`,
    identities: [params.key ?? selectedAgent.agentId],
    assertAllowed: assertCurrent,
    onInterrupt: (reason) => interrupted.abort(reason),
  });
  try {
    return await admission.run(() =>
      create({ ...params, commitGuard: assertCurrent }, selectedAgent.agentId),
    );
  } finally {
    admission.release();
  }
}

export async function validateSessionCreateIncognitoTarget(
  params: CreateGatewaySessionParams,
  agentId: string,
  explicitTargetKey: string | undefined,
  commitGuard: CreateGatewaySessionParams["commitGuard"],
): Promise<Result<void, ErrorShape>> {
  const explicitTargetParts = parseAgentSessionKey(explicitTargetKey);
  const explicitIncognito = isIncognitoSessionKey(explicitTargetKey);
  const explicitDashboardIncognito =
    explicitIncognito &&
    explicitTargetParts?.agentId === agentId &&
    explicitTargetParts.rest.startsWith("dashboard:");
  if (explicitIncognito && params.incognito !== true) {
    return invalidSessionRequest("incognito-shaped session keys require incognito: true");
  }
  if (params.incognito === true && explicitTargetKey) {
    if (!explicitDashboardIncognito) {
      return invalidSessionRequest("incognito sessions are web-only");
    }
    const durableStorePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    const durable = await readSessionEntriesFromStoreInWorker({
      agentId,
      storePath: durableStorePath,
      sessionKeys: [explicitTargetKey],
      projection: "list",
    });
    commitGuard?.();
    if (
      durable.entries.length > 0 ||
      (
        await loadGatewaySessionEntryReadOnlyInWorker({
          cfg: params.cfg,
          key: explicitTargetKey,
          agentId,
          assertActive: commitGuard,
        })
      ).entry
    ) {
      return invalidSessionRequest("incognito is immutable and requires a new session key");
    }
  }
  return { ok: true, value: undefined };
}

export async function readRequestedSessionCreateTarget(
  params: CreateGatewaySessionParams,
  agentId: string,
  key: string | undefined,
) {
  return key
    ? await loadGatewaySessionEntryReadOnlyInWorker({ cfg: params.cfg, key, agentId })
    : undefined;
}

// The caller holds target lifecycle custody from this reread through commit and rollback.
export async function readSessionCreateTarget(
  params: CreateGatewaySessionParams,
  target: GatewaySessionStoreTarget,
  expectedSessionId: string | undefined,
  lifecycleIdentities: readonly string[],
): Promise<Result<InternalSessionEntry | undefined, ErrorShape>> {
  const assertRoutingCurrent = captureSessionMutationRouting(params.cfg, undefined, [
    { agentId: target.agentId, sessionKey: target.canonicalKey },
  ]);
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
  const memory = getSessionActorStorageBinding({
    agentId: target.agentId,
    sessionKey: target.canonicalKey,
    storePath: target.storePath,
  });
  if (memory) {
    return validate(
      memory.actor.storage!.readCurrent(
        { type: "session.entry.read", input: {} },
        memory.authority,
      ),
    );
  }
  // Process-held incognito stores retain their native owner until its complete cutover.
  if (isIncognitoSessionKey(target.canonicalKey)) {
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
