import { captureIncognitoSessionSource } from "../../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { operatorScopeSatisfied } from "../../shared/operator-scope-compat.js";
import { resolveGatewayOperatorRoleActor } from "../operator-role-policy.js";
import {
  hasSessionReadAccessChanged,
  hiddenSessionNotFound,
  sharingIdentity,
} from "../session-sharing-policy.js";
import { captureSessionMutationRouting } from "../session-sharing-preparation.js";
import {
  createSessionListEntryFilter,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import { retainGatewaySessionEntryReadOnly } from "../session-utils-read-lifetime.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function retainIncognitoScopedRead(
  binding: NonNullable<ReturnType<typeof captureIncognitoSessionSource>>,
  sessionKey: string,
  cfg: OpenClawConfig,
  allowMetadataChanges: boolean,
) {
  const actor = "kind" in binding ? undefined : binding.actor;
  const claim = actor?.sessions.captureCurrent(sessionKey);
  const entry = actor?.sessions.readSharing(sessionKey)?.entry;
  const revision = actor?.sessions.readEntryRevision(sessionKey);
  const assertRoutingCurrent = captureSessionMutationRouting(cfg);
  let released = false;
  return {
    entry,
    canonicalKey: sessionKey,
    legacyKey: undefined,
    isCurrentAtResponse(currentCfg: OpenClawConfig) {
      if (released) {
        return false;
      }
      binding.admissionSignal?.throwIfAborted();
      assertRoutingCurrent(currentCfg);
      if ("kind" in binding) {
        binding.assertCurrent();
        return true;
      }
      claim?.assertCurrent();
      const current = binding.actor.sessions.readSharing(sessionKey)?.entry;
      return entry && current
        ? !hasSessionReadAccessChanged(entry, current) &&
            (allowMetadataChanges ||
              binding.actor.sessions.readEntryRevision(sessionKey) === revision)
        : entry === current;
    },
    release() {
      released = true;
    },
  };
}

/** Person-owned reads retain visibility, row generation and the physical store through I/O. */
export function retainSessionScopedRead(
  options: GatewayRequestHandlerOptions,
  sessionKey: string,
  agentId: string,
  readOptions: { requireMaterialized?: boolean; allowMetadataChanges?: boolean } = {},
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
  if (!narrow && !initialVisibility) {
    return undefined;
  }
  const { canonicalKey } = resolveSessionStoreIdentity({ cfg, sessionKey, agentId });
  const binding = captureIncognitoSessionSource({ sessionKey: canonicalKey, agentId });
  const read = binding
    ? retainIncognitoScopedRead(
        binding,
        canonicalKey,
        cfg,
        Boolean(readOptions.allowMetadataChanges),
      )
    : retainGatewaySessionEntryReadOnly(
        sessionKey,
        agentId,
        readOptions.allowMetadataChanges
          ? (previous, current) => !hasSessionReadAccessChanged(previous, current)
          : undefined,
      );
  const assertCurrent = () => {
    authority.assertCurrent();
    const currentCfg = getConfig();
    const currentActor = resolveGatewayOperatorRoleActor(options.client);
    const visible = createSessionListEntryFilter({
      client: options.client,
      cfg: currentCfg,
    });
    if (
      (narrow &&
        (!operatorProfileId ||
          currentActor?.kind !== "operator" ||
          currentActor.profileId !== operatorProfileId)) ||
      (narrow &&
        !operatorScopeSatisfied("operator.sessions.read", options.client?.connect.scopes ?? [])) ||
      sharingIdentity(options.client, currentActor)?.id !== profileId ||
      (readOptions.requireMaterialized && !read.entry?.sessionId) ||
      !read.isCurrentAtResponse(currentCfg) ||
      (read.entry && visible?.(read.legacyKey ?? read.canonicalKey, read.entry) === false)
    ) {
      throw new SessionMutationAuthorizationChangedError(hiddenSessionNotFound(sessionKey));
    }
  };
  try {
    assertCurrent();
    return { assertCurrent, release: read.release };
  } catch (error) {
    read.release();
    throw error;
  }
}
