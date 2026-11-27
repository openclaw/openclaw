import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SqliteLifecycleTargetSnapshot } from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import {
  ARCHIVE_UNDO_CHANGED,
  isArchiveUndoRequestShape,
  type SessionArchiveUndoIntent,
} from "../../config/sessions/session-archive-undo.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import {
  isSessionArchiveUndoIssuer,
  supportsSessionArchiveUndo,
} from "../session-pin-compatibility.js";
import { invalidSessionRequest } from "../session-request-error.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import type { SessionPatchTargetIdentity } from "./session-unread-ack.js";
import type {
  ArchiveUndoCaller,
  GroupMutationOperation,
  MutationOutcome,
  PreparedPatchTarget,
} from "./sessions-patch-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// Mac shows Undo for six seconds of unpaused time; abandoned capabilities have a separate hard bound.
const UNDO_MAX_AGE_MS = 60 * 60_000;
export function admitArchiveUndo(
  options: GatewayRequestHandlerOptions,
  patch: Omit<SessionsPatchParams, "key">,
  targets: readonly SessionPatchTargetIdentity[],
): { ok: true; caller?: ArchiveUndoCaller } | ReturnType<typeof invalidSessionRequest> {
  const { client, context } = options;
  const token = patch.archiveUndoToken;
  const issue = patch.requestArchiveUndo === true;
  if (!issue && token === undefined) {
    return { ok: true };
  }
  if (
    issue === (token !== undefined) ||
    patch.archived !== issue ||
    !isArchiveUndoRequestShape(patch, targets)
  ) {
    return invalidSessionRequest(
      "Send Archive Undo only with its Archive or Restore and exact session identity.",
    );
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  const connId = client?.connId;
  const isCurrent = () =>
    Boolean(
      client &&
      connId &&
      client.connId === connId &&
      profileId &&
      client.authenticatedUserProfile?.profileId === profileId &&
      isSessionArchiveUndoIssuer(client) &&
      !client.invalidated &&
      !client.connectionSignal?.aborted &&
      options.hasCurrentClientAuthority?.() !== false &&
      context.isConnectionActive?.(connId, client),
    );
  if (
    !profileId ||
    !connId ||
    !supportsSessionArchiveUndo(client, context.getRuntimeConfig()) ||
    !isCurrent()
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.FORBIDDEN,
        "Archive Undo requires the same signed-in personal connection.",
      ),
    };
  }
  return {
    ok: true,
    caller: {
      profileId,
      connId,
      token,
      assertCurrent: () => {
        if (!isCurrent()) {
          throw new SessionMutationAuthorizationChangedError(
            errorShape(ErrorCodes.FORBIDDEN, "The Archive Undo connection changed."),
          );
        }
      },
    },
  };
}

export function supportsArchiveUndoTarget(target: PreparedPatchTarget): boolean {
  return Boolean(
    target.initialEntry &&
    !target.initialEntry.incognito &&
    !isIncognitoSessionKey(target.canonicalKey) &&
    target.initialTarget.capturedReadSource,
  );
}

type PreparedArchive = { ok: true; intent?: SessionArchiveUndoIntent; token?: string };
export function bindArchiveUndoToReplacement(
  receipts: NonNullable<GroupMutationOperation["archiveReceipts"]>,
  prepared: PreparedArchive,
  replacement: NonNullable<GroupMutationOperation["replacements"]>[number],
  outcome: Extract<MutationOutcome, { ok: true }>,
) {
  if (prepared.intent) {
    replacement.archiveUndo = prepared.intent;
  }
  if (prepared.token) {
    receipts.set(replacement.sessionKey, { token: prepared.token, outcome });
  }
}

export function prepareArchiveUndo(
  caller: ArchiveUndoCaller | undefined,
  target: PreparedPatchTarget,
  primaryKey: string,
  entry: SessionEntry | undefined,
  entries: SqliteLifecycleTargetSnapshot,
): PreparedArchive | ReturnType<typeof invalidSessionRequest> {
  if (!caller) {
    return {
      ok: true,
      ...(target.fullPatch.pinned !== undefined || target.fullPatch.archived !== undefined
        ? { intent: { kind: "invalidate" as const } }
        : {}),
    };
  }
  const marker = caller.token
    ? entries.find((row) => row.sessionKey === primaryKey)?.archiveUndoMarker
    : undefined;
  const source = target.initialTarget.capturedReadSource;
  if (!source || !entry || entry.incognito || primaryKey !== target.canonicalKey) {
    return invalidSessionRequest(ARCHIVE_UNDO_CHANGED);
  }
  const now = Date.now();
  const handle = caller.token ?? `${now + UNDO_MAX_AGE_MS}.${randomUUID()}`;
  const expiresAt = Number(handle.split(".", 1)[0]);
  const digest = sha256Base64Url(
    JSON.stringify([
      handle,
      caller.connId,
      caller.profileId,
      source.databaseIdentity,
      source.databaseBirthtime,
      source.path,
      target.targetAgentId,
      primaryKey,
      entry.sessionId,
      entry.lifecycleRevision,
    ]),
  );
  if (
    caller.token
      ? entry.archivedAt === undefined ||
        !(expiresAt > now) ||
        (marker !== `0:${digest}` && marker !== `1:${digest}`)
      : entry.archivedAt !== undefined
  ) {
    return invalidSessionRequest(ARCHIVE_UNDO_CHANGED);
  }
  return {
    ok: true,
    intent: { kind: caller.token ? "undo" : "archive", digest, expiresAt },
    ...(!caller.token ? { token: handle } : {}),
  };
}
