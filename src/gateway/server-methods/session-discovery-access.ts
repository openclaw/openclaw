import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { withReadySessionRows } from "../session-row-prepared-read.js";
import {
  getSessionRowProjection,
  requireSessionRowProjection,
} from "../session-row-projection-access.js";
import type { SessionSharingTarget } from "../session-sharing-policy.js";
import {
  isSameSessionSharingTarget,
  prepareSessionSharingRead,
} from "../session-sharing-target-read.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { prepareCurrentSessionSharing } from "./sessions-sharing-authority.js";
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
  const { client, context, respond } = params;
  const cfg = context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    respond(false, undefined, requestedAgent.error);
    return;
  }
  const projection = requireSessionRowProjection(context);
  const targetRef = { sessionKey: params.sessionKey, agentId: requestedAgent.agentId };
  const actorId = gatewayClientSessionCreator(client)?.id;
  const runAuthority = client?.internal?.operatorRunAuthority;
  const assertCaller = () => {
    params.signal?.throwIfAborted();
    if (
      params.hasCurrentClientAuthority?.() === false ||
      client?.invalidated ||
      client?.connectionSignal?.aborted ||
      gatewayClientSessionCreator(client)?.id !== actorId ||
      getSessionRowProjection(context) !== projection ||
      client?.internal?.operatorRunAuthority !== runAuthority
    ) {
      throw new Error("Session discovery authority changed.");
    }
  };
  let facts: Awaited<ReturnType<typeof prepareSessionSharingRead>> | undefined;
  try {
    assertCaller();
    const query = { key: targetRef.sessionKey, agentId: targetRef.agentId };
    facts = await prepareSessionSharingRead({ cfg, ...targetRef, projection });
    const sourcePath = facts.readCurrent(context.getRuntimeConfig()).sourcePath;
    const readCurrent = (selected?: SessionSharingTarget) => {
      assertCaller();
      const { currentCfg, sharing } = prepareCurrentSessionSharing({
        client,
        context,
        projection,
        actorId,
        runAuthority,
        isMember: (_target, identityId) => membership.has(identityId),
      });
      const { target, membership } = facts!.readCurrent(currentCfg);
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
  } finally {
    facts?.release();
  }
}
