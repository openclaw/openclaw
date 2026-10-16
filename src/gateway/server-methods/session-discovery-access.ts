import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import { isSameSessionSharingTarget } from "../session-sharing-target-read.js";
import { prepareSessionSharingAccess } from "./sessions-sharing-authority.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Keep discovery bound to current sharing facts and the session's selected skill revisions. */
export async function withSessionDiscoveryAccess(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "respond" | "signal" | "hasCurrentClientAuthority"
  > & { sessionKey?: string; agentId: string; changedError: ErrorShape },
  discover: (entry?: SessionEntry) => Promise<unknown>,
): Promise<void> {
  if (!params.sessionKey) {
    params.respond(true, await discover(), undefined);
    return;
  }
  const { respond } = params;
  try {
    using access = await prepareSessionSharingAccess(
      { ...params, sessionKey: params.sessionKey },
      () => {
        throw new Error("Session discovery authority changed.");
      },
    );
    if (!access) {
      return;
    }
    const { query, projection } = access;
    const sourcePath = access.readCurrent().sourcePath;
    const readCurrent = (selected?: SessionSharingTarget) => {
      const { target, sharing } = access.readCurrent();
      if (selected && !isSameSessionSharingTarget(target, selected)) {
        throw new SessionMutationAuthorizationChangedError(params.changedError);
      }
      if (!target) {
        throw new SessionMutationAuthorizationChangedError(
          errorShape(ErrorCodes.INVALID_REQUEST, "Session not found."),
        );
      }
      const denied = sharing.authorizeTarget(target);
      if (denied) {
        throw new SessionMutationAuthorizationChangedError(denied);
      }
      return target;
    };
    const selected = readCurrent();
    const readEntry = <T>(consume: (entry: SessionEntry) => T) =>
      withReadySessionRows(
        projection,
        () => [query],
        (read) => {
          readCurrent(selected);
          const row = read.describe(query);
          const entry = row?.storedEntry;
          if (
            !entry ||
            (read.readSource(row)?.path ?? row.storeTarget.storePath) !==
              (sourcePath ?? selected.storePath) ||
            entry.sessionId !== selected.entry.sessionId ||
            entry.lifecycleRevision !== selected.entry.lifecycleRevision
          ) {
            throw new SessionMutationAuthorizationChangedError(params.changedError);
          }
          return consume(entry);
        },
      );
    const entry = await readEntry((current) => structuredClone(current));
    readCurrent(selected);
    const result = await discover(entry);
    // Refuse unresolved membership before row preparation can refresh it.
    readCurrent(selected);
    await readEntry((current) => {
      if (!isDeepStrictEqual(current.skillLibrarySelections, entry.skillLibrarySelections)) {
        throw new SessionMutationAuthorizationChangedError(params.changedError);
      }
      respond(true, result, undefined);
    });
  } catch (error) {
    respond(
      false,
      undefined,
      error instanceof SessionMutationAuthorizationChangedError
        ? error.error
        : errorShape(ErrorCodes.INVALID_REQUEST, formatErrorMessage(error)),
    );
  }
}
