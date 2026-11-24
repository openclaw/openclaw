import { randomUUID } from "node:crypto";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SqliteLifecycleTargetSnapshot } from "../../config/sessions/session-accessor.sqlite-entry-equality.js";
import {
  ARCHIVE_UNDO_CHANGED,
  type SessionArchiveUndoIntent,
} from "../../config/sessions/session-archive-undo.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import { resolveDatabaseFamilyEngines } from "../../infra/database-engine/registry.js";
import { isIncognitoSessionKey } from "../../shared/incognito-session-key.js";
import { invalidSessionRequest } from "../session-request-error.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { isIneligiblePersonalGatewayCaller } from "./gateway-personal-caller.js";
import type { SessionPatchTargetIdentity } from "./session-unread-ack.js";
import type {
  GroupMutationOperation,
  MutationOutcome,
  PreparedPatchTarget,
} from "./sessions-patch-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const ALLOWED_FIELDS = new Set([
  "archived",
  "requestArchiveUndo",
  "archiveUndoToken",
  "key",
  "agentId",
  "expectedSessionId",
  "expectedLifecycleRevision",
]);
// Mac shows Undo for six seconds of unpaused time; abandoned capabilities have a separate hard bound.
const UNDO_MAX_AGE_MS = 60 * 60_000;
export type ArchiveUndoCaller = {
  profileId: string;
  connId: string;
  token?: string;
  assertCurrent: () => void;
};

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
    Object.keys(patch).some((key) => !ALLOWED_FIELDS.has(key)) ||
    targets.some(
      (target) =>
        !target.expectedSessionId || Object.keys(target).some((key) => !ALLOWED_FIELDS.has(key)),
    )
  ) {
    return invalidSessionRequest(
      "Send Archive Undo only with its Archive or Restore and exact session identity.",
    );
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  const connId = client?.connId;
  // Ordinary RPCs can outlive the socket. Undo belongs to this exact, still-live transport.
  const isCurrent = () =>
    Boolean(
      client &&
      connId &&
      profileId &&
      client.authenticatedUserProfile?.profileId === profileId &&
      client.connect.role === "operator" &&
      !client.internal?.remoteIngressPrincipal &&
      !client.internal?.operatorRunAuthority &&
      !isIneligiblePersonalGatewayCaller(client) &&
      context.isConnectionActive?.(connId, client),
    );
  if (
    !profileId ||
    !connId ||
    !client ||
    !isCurrent() ||
    !hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.PERSONAL_SESSION_PINS) ||
    resolveDatabaseFamilyEngines(context.getRuntimeConfig()).agent !== "sqlite"
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
