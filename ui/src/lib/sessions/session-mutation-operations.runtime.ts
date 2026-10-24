import type {
  SessionsPatchManyParams,
  SessionsPatchManyResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { SESSION_ARCHIVE_REQUEST_OPTIONS } from "../../../../src/shared/session-archive-timeout.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { formatUiError } from "../format-error.ts";
import { showToast } from "../toast.ts";
import {
  requestSessionCreate,
  type SessionCreateParams,
  type SessionCreateRequestOptions,
} from "./create.ts";
import type { SessionPatch, SessionPatchOptions, SessionPatchRoute } from "./patch.ts";
import { projectSessionArchiveFields } from "./session-archive-state.ts";
import { resolveSessionCreateParams } from "./session-create-params.ts";
import type { Deletion, SessionDeferredDeletionHost } from "./session-deletions.ts";
import type { createSessionModelOverrides } from "./session-model-overrides.ts";
import {
  registerSessionMutationOperations,
  type PreparedSessionMutation,
} from "./session-mutation-operations.ts";
import type { createSessionMutationRefresh } from "./session-mutation-refresh.ts";
import type { SessionMutationsHost } from "./session-mutations-host.ts";
import { projectSessionPatchRowFields } from "./session-patch-row-facts.ts";
import {
  createOptimisticRowPatches,
  type createOptimisticRowField,
  type PendingRowTarget,
  type SessionPinFields,
  resolvePendingConversation,
} from "./session-pending-rows.ts";
import type {
  SessionConnectionScope,
  SessionCreateReconciliation,
  SessionRequestClient,
} from "./session-types.ts";

type MetadataField = "label" | "icon" | "color" | "category";
type MetadataFieldOwner = ReturnType<typeof createOptimisticRowField<MetadataField>>;

export function createOptimisticArchivePatches(host: SessionMutationsHost) {
  const fields = [
    "archived",
    "archivedAt",
    "archivedBy",
    "archiveReason",
    "pinned",
    "pinnedAt",
  ] as const;
  return createOptimisticRowPatches(host, {
    read: (row): Pick<GatewaySessionRow, (typeof fields)[number]> =>
      Object.fromEntries(fields.map((field) => [field, row?.[field]])),
    write: (row, next) =>
      fields.every((field) => row[field] === next[field]) ? row : host.copyRow(row, next),
    observe: (previous, row, names) => ({
      ...previous,
      ...Object.fromEntries(
        fields.filter((field) => names.includes(field)).map((field) => [field, row[field]]),
      ),
    }),
  });
}

export function prepareSessionPatch(
  host: SessionMutationsHost,
  metadataFields: Record<MetadataField, MetadataFieldOwner>,
  archiveOwner: (
    create: typeof createOptimisticArchivePatches,
  ) => ReturnType<typeof createOptimisticArchivePatches>,
  patch: SessionPatchRoute,
  target: PendingRowTarget,
  patchParams: SessionPatch,
  options: SessionPatchOptions,
): PreparedSessionMutation {
  const archive = archiveOwner(createOptimisticArchivePatches);
  const claims: Array<readonly [MetadataFieldOwner, symbol | null]> = [];
  const archived = patchParams.archived;
  let archiveToken =
    typeof archived === "boolean"
      ? archive.prepare(() => projectSessionArchiveFields(archived))(target)
      : null;
  const settle = () => {
    if (archiveToken) {
      archive.settle(target, archiveToken, false, true);
    }
    for (const [owner, token] of claims) {
      if (token) {
        owner.settle(target, token, false, true);
      }
    }
  };
  // Warm admission installs newer tokens before coalescing releases their predecessor.
  for (const field of ["label", "icon", "color", "category"] as const) {
    if (patchParams[field] !== undefined) {
      const owner = metadataFields[field];
      claims.push([owner, owner.prepare(() => patchParams[field]?.trim() || undefined)(target)]);
    }
  }
  return {
    admit() {
      // A superseded delete restores its hidden row during admission.
      if (!archiveToken && typeof archived === "boolean") {
        archiveToken = archive.prepare(() => projectSessionArchiveFields(archived))(target);
      }
    },
    async run() {
      try {
        const result = await patch(target.key, patchParams, {
          ...options,
          agentId: target.agentId,
          expectedSessionId: target.sessionId,
          // The initiating dialog or batch has completed; replay owns refresh.
          deferListRefresh: false,
        });
        const error = host.readState().error;
        if (result === null && error) {
          showToast({ message: error });
        }
      } catch (error) {
        showToast({ message: formatUiError(error) });
      } finally {
        settle();
        options.onDeferredSettled?.();
      }
    },
    discard: settle,
  };
}

export function prepareSessionDelete(
  record: Deletion,
  key: string,
  host: SessionDeferredDeletionHost,
): PreparedSessionMutation {
  return {
    admit() {
      const row = host.publishedRow(
        (candidate) => candidate.key === key && candidate.sessionId === record.sessionId,
      );
      // Coalescing an unsent archive retains archive-only deletion authorization.
      if (record.target.archivedOnly && row && !row.archived) {
        record.archiveBeforeDelete = true;
      }
      record.phase = "pending";
    },
    run(scope) {
      return import("./session-delete-operation.ts").then(
        ({ runDeferredSessionDelete }) => runDeferredSessionDelete(record, scope, host),
        (error: unknown) => {
          if (host.owns(record)) {
            host.rollback(record);
            host.reportError(formatUiError(error));
          }
        },
      );
    },
  };
}

export async function createSessionResult(
  host: SessionMutationsHost,
  scope: SessionConnectionScope,
  params: SessionCreateParams,
  options: SessionCreateRequestOptions & { reconciliation?: SessionCreateReconciliation },
  owner: {
    preparedWorkSessionKeys: Set<string>;
    modelOverrides: Pick<ReturnType<typeof createSessionModelOverrides>, "set">;
    reconcileConfirmedPreviousConnection: ReturnType<
      typeof createSessionMutationRefresh
    >["reconcileConfirmedPreviousConnection"];
    reportError: (scope: SessionConnectionScope, error: unknown) => void;
  },
) {
  if (!host.connection.isCurrent(scope) || options.signal?.aborted) {
    return null;
  }
  const { currentSessionKey, ...requestParams } = params;
  const result = await requestSessionCreate(
    scope.client,
    {
      ...requestParams,
      ...resolveSessionCreateParams(currentSessionKey, params.agentId),
    },
    options,
  );
  if (!host.connection.isCurrent(scope)) {
    return (await owner.reconcileConfirmedPreviousConnection(scope, params.agentId))
      ? result
      : null;
  }
  // Creation precedes canonical rows; claim placement before any event or
  // list publication can assign this key an ordinary roster position.
  host.notifyCreated(result.key, result.entry, requestParams.agentId);
  if (requestParams.worktree === true || Boolean(requestParams.execNode?.trim())) {
    owner.preparedWorkSessionKeys.add(result.key.trim());
  }
  if (requestParams.model?.trim()) {
    owner.modelOverrides.set(result.key, requestParams.model, true);
  } else if (owner.preparedWorkSessionKeys.has(result.key)) {
    host.publish({ ...host.readState() });
  }
  const reconciliation = host.reconcileMutation(params.agentId, undefined, true);
  if (options.reconciliation === "background") {
    void reconciliation.catch((error: unknown) => owner.reportError(scope, error));
  } else {
    await reconciliation;
    if (!host.connection.isCurrent(scope)) {
      return (await owner.reconcileConfirmedPreviousConnection(scope, params.agentId))
        ? result
        : null;
    }
  }
  return result;
}

export async function patchSessionBatch(
  host: SessionMutationsHost,
  scope: SessionConnectionScope,
  snapshot: ReturnType<SessionMutationsHost["snapshot"]>,
  targets: SessionsPatchManyParams["targets"],
  patchParams: SessionsPatchManyParams["patch"],
): Promise<SessionsPatchManyResult | null> {
  if (!host.connection.isCurrent(scope)) {
    return null;
  }
  const { archived, pinned } = patchParams;
  // Batch outcomes confirm pin intent without returning the Gateway's pin timestamp.
  const pin: SessionPinFields | { pinned: true } | undefined =
    pinned === true
      ? { pinned: true }
      : pinned === false
        ? { pinned: false, pinnedAt: undefined }
        : undefined;
  const fields =
    archived === undefined
      ? pin
      : { ...projectSessionArchiveFields(archived), ...(archived ? undefined : pin) };
  const confirmations = fields
    ? targets.map((target) => {
        const identity = resolvePendingConversation(snapshot, target.key, target.agentId);
        const sessionId = target.expectedSessionId?.trim();
        if (!identity || !sessionId) {
          return null;
        }
        const owned = { ...identity, sessionId };
        return { owned, confirm: host.capturePatchFields(owned) };
      })
    : [];
  const result = await requestSessionPatchMany(scope.client, { targets, patch: patchParams });
  if (!host.connection.isCurrent(scope)) {
    return result;
  }
  if (fields) {
    const readCutoff = host.readRevision();
    result.outcomes.forEach((outcome, index) => {
      const confirmation = confirmations[index];
      if (outcome.ok && confirmation) {
        confirmation.confirm({
          key: confirmation.owned.key,
          agentId: confirmation.owned.agentId,
          sessionId: confirmation.owned.sessionId,
          updatedAt: null,
          readCutoff,
          fields,
        });
      }
    });
  }
  return result;
}

export function requestSessionPatchMany(
  client: SessionRequestClient,
  params: SessionsPatchManyParams,
): Promise<SessionsPatchManyResult> {
  return params.patch.archived === true
    ? client.request<SessionsPatchManyResult>(
        "sessions.patchMany",
        params,
        SESSION_ARCHIVE_REQUEST_OPTIONS,
      )
    : client.request<SessionsPatchManyResult>("sessions.patchMany", params);
}

export { projectSessionPatchRowFields };

registerSessionMutationOperations({
  prepareSessionPatch,
  prepareSessionDelete,
  patchSessionBatch,
  createSessionResult,
  projectSessionPatchRowFields,
});
