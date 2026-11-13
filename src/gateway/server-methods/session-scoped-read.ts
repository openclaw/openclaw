import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { SessionEntryReadScope } from "../../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import {
  authorizeGatewaySessionCreation,
  operatorSessionCap,
  resolveGatewayOperatorRoleActor,
} from "../operator-role-policy.js";
import {
  hasSessionReadAccessChanged,
  hiddenSessionNotFound,
  sharingIdentity,
} from "../session-sharing-policy.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import { prepareSessionSharingRead } from "../session-sharing-target-read.js";
import {
  createSessionListEntryFilter,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { retainGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./types.js";

/**
 * A session writer allowed to start sessions for the agent creates its main conversation with its
 * first turn and becomes its creator, so its absence discloses nothing. Every other missing key,
 * including main for an agent the caller's role excludes, stays indistinguishable from a hidden
 * one for narrow readers.
 */
function isStartableMainSession(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null | undefined;
  sessionKey: string;
  agentId: string;
}): boolean {
  const { cfg, client, agentId } = params;
  if (
    !operatorScopeSatisfied("operator.sessions.write", client?.connect.scopes ?? []) ||
    authorizeGatewaySessionCreation({ cfg, client, agentId })
  ) {
    return false;
  }
  const canonicalKey = (sessionKey: string) =>
    resolveSessionStoreIdentity({ cfg, sessionKey, agentId }).canonicalKey;
  return (
    canonicalKey(params.sessionKey) === canonicalKey(resolveAgentMainSessionKey({ cfg, agentId }))
  );
}

/** Person-owned reads retain visibility, row generation and the physical store through I/O. */
export async function retainSessionScopedRead(
  options: GatewayRequestHandlerOptions,
  sessionKey: string,
  agentId: string,
  readOptions: {
    requireMaterialized?: boolean;
    /** Admit the caller's own not-yet-created main conversation despite requireMaterialized. */
    allowStartableMain?: boolean;
    allowMetadataChanges?: boolean;
    retain?: boolean;
    projection?: SessionEntryReadScope["projection"];
    entryMatches?: NonNullable<Parameters<typeof retainGatewaySessionEntryReadOnly>[2]>;
    prepared?: {
      cfg: OpenClawConfig;
      pending: ReturnType<typeof retainGatewaySessionEntryReadOnly>;
    };
  } = {},
) {
  const authority = readGatewayRequestMutationAuthority(options);
  const actor = resolveGatewayOperatorRoleActor(options.client);
  const profileId = sharingIdentity(options.client, actor)?.id;
  const operatorProfileId = actor?.kind === "operator" ? actor.profileId : undefined;
  const narrow = authority.sessionScope === "operator.sessions.read";
  const getConfig = options.context.getCommittedRuntimeConfig ?? options.context.getRuntimeConfig;
  const cfg = getConfig();
  // Canonical solo owner, admin and system exemptions keep their existing workspace access.
  const initialVisibility = createSessionListEntryFilter({
    client: options.client,
    cfg,
  });
  if (!readOptions.retain && !narrow && !initialVisibility) {
    return undefined;
  }
  const assertRoutingCurrent = captureSessionMutationRouting(cfg, undefined, [
    { sessionKey, agentId },
  ]);
  const borrowed = readOptions.prepared?.cfg === cfg ? readOptions.prepared.pending : undefined;
  const read = await (borrowed ??
    retainGatewaySessionEntryReadOnly(
      sessionKey,
      agentId,
      readOptions.entryMatches ??
        (readOptions.allowMetadataChanges
          ? (previous, current) => !hasSessionReadAccessChanged(previous, current)
          : undefined),
      cfg,
      { projection: readOptions.projection },
    ));
  let sharing: Awaited<ReturnType<typeof prepareSessionSharingRead>> | undefined;
  const release = () => {
    sharing?.release();
    if (!borrowed) {
      read.release();
    }
  };
  const assertCurrent = () => {
    authority.assertCurrent();
    const currentCfg = getConfig();
    assertRoutingCurrent(currentCfg);
    const currentActor = resolveGatewayOperatorRoleActor(options.client);
    const visible = createSessionListEntryFilter({
      client: options.client,
      cfg: currentCfg,
      membership: sharing?.readCurrent(currentCfg).membership,
    });
    if (
      (narrow &&
        (!operatorProfileId ||
          currentActor?.kind !== "operator" ||
          currentActor.profileId !== operatorProfileId)) ||
      (narrow &&
        !operatorScopeSatisfied("operator.sessions.read", options.client?.connect.scopes ?? [])) ||
      sharingIdentity(options.client, currentActor)?.id !== profileId ||
      (readOptions.requireMaterialized &&
        !read.entry?.sessionId &&
        !(
          readOptions.allowStartableMain &&
          !read.entry &&
          isStartableMainSession({ cfg: currentCfg, client: options.client, sessionKey, agentId })
        )) ||
      !read.isCurrentAtResponse() ||
      (read.entry && visible?.(read.legacyKey ?? read.canonicalKey, read.entry) === false)
    ) {
      throw new SessionMutationAuthorizationChangedError(hiddenSessionNotFound(sessionKey));
    }
  };
  try {
    if (operatorSessionCap(options.client, cfg) === "invited") {
      sharing = await prepareSessionSharingRead({ cfg, sessionKey, agentId });
    }
    assertCurrent();
    return { assertCurrent, release, prepared: read };
  } catch (error) {
    release();
    throw error;
  }
}
