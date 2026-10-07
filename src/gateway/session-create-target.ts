import type { Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
} from "../../packages/gateway-protocol/src/index.js";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent-runner/runs.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { isSessionWorkAdmissionActive } from "../sessions/session-lifecycle-admission.js";
import { authorizeGatewaySessionCreation } from "./operator-role-policy.js";
import type { CreateGatewaySessionParams } from "./session-create-service.types.js";
import { resolvePluginSessionOwnershipError } from "./session-plugin-ownership.js";
import { captureSessionMutationRouting } from "./session-sharing-preparation.js";
import { findCanonicalStoreMatch } from "./session-utils-store-selection.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils-store.js";
import type { GatewaySessionStoreTarget } from "./session-utils-store.types.js";

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
  const validate = (entry: InternalSessionEntry | undefined) => {
    assertCurrent();
    return validateSessionCreateTarget(
      params,
      target,
      entry,
      expectedSessionId,
      lifecycleIdentities,
    );
  };
  assertCurrent();
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

function validateSessionCreateTarget(
  params: CreateGatewaySessionParams,
  target: GatewaySessionStoreTarget,
  currentTargetEntry: InternalSessionEntry | undefined,
  expectedSessionId: string | undefined,
  lifecycleIdentities: readonly string[],
): Result<InternalSessionEntry | undefined, ErrorShape> {
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
    const requestedRoot = normalizeOptionalString(params.sessionRoot ?? params.defaultSessionRoot);
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
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${target.canonicalKey} changed before workspace preparation; retry.`,
          ),
        };
      }
      if (
        isSessionWorkAdmissionActive(target.storePath, lifecycleIdentities) ||
        isEmbeddedAgentRunActive(currentTargetEntry.sessionId)
      ) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.UNAVAILABLE,
            `Session ${target.canonicalKey} is still active; retry workspace preparation after its work finishes.`,
          ),
        };
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
}
