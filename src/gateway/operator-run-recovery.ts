import { isDeepStrictEqual } from "node:util";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { restoreOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import type { RequesterOrigin } from "../agents/requester-origin.js";
import { readRestartRecoveryRequesterSource } from "../agents/requester-run-recovery-source.js";
import { prepareCommandOwnerAuthority } from "../auto-reply/command-auth.js";
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { isPairedDeviceTokenIdentityCurrent } from "../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import {
  GatewayOperatorRecoveryAuthorizationError,
  GatewayOperatorRecoveryOwnershipError,
} from "../infra/restart-recovery-errors.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { intersectOperatorScopes } from "../shared/operator-scope-compat.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { profileCatalogPath } from "../state/user-profile-identity.read.js";
import {
  prepareUserProfileIdentity,
  projectUserProfileDisplay,
  readResidentUserProfileRevision,
} from "../state/user-profile-list.js";
import { captureGatewayAuthPolicy, isGatewayAuthGrantCurrent } from "./auth-policy.js";
import type { GatewayAuthPolicy } from "./auth-policy.types.js";
import {
  captureGatewayDeviceRevocation,
  onGatewayDeviceSourceRevoked,
} from "./device-revocation.js";
import {
  GatewayOperatorAccessDeniedError,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import {
  onOperatorRolePolicyChanged,
  readOperatorRoleConfigRevision,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import {
  isOperatorRoleSourcePolicyCurrent,
  sourceRolePolicy,
} from "./operator-role-source-policy.js";
import {
  bindGatewayOperatorContinuationAuthority,
  captureChannelOperatorRunAuthority,
  intersectOperatorRunModelPolicy,
} from "./operator-run-authority.js";
import { prepareRestartRecoveryParentSource } from "./operator-run-recovery-parent.js";
import {
  decodeGatewayOperatorRecoverySource,
  decodeQueuedOperatorRecoverySource,
  type OperatorRunRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";
import type { GatewayAuthenticatedUserProfile } from "./server/client-identity-types.js";

export type OperatorRecoveryTarget = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  sessionId: string;
  sourceRunId: string;
  recoveryRunId: string;
};

type RecoverySource = Readonly<{ controlUiAdmin: boolean; localOperator: boolean }>;

const recoverySources = new WeakMap<
  AdmittedRunOperatorAuthority,
  {
    target: OperatorRecoveryTarget;
    source: RecoverySource;
  }
>();

/** Only an exact live restore can carry the original operator admission classification. */
export function readGatewayOperatorRecoverySource(
  authority: AdmittedRunOperatorAuthority | undefined,
  target: { runId: string; sessionKey: string; sessionId: string },
): RecoverySource | undefined {
  const restored = authority && recoverySources.get(authority);
  if (
    !authority ||
    !restored ||
    restored.target.recoveryRunId !== target.runId ||
    restored.target.sessionKey !== target.sessionKey ||
    restored.target.sessionId !== target.sessionId
  ) {
    return undefined;
  }
  authority.assertCurrent();
  return restored.source;
}

export type RestoredGatewayOperatorAuthority = {
  authority: AdmittedRunOperatorAuthority;
  /** Original caller policy remains authoritative when its recovered execution is canceled. */
  assertPolicyCurrent: () => void;
  authenticatedUserProfile: GatewayAuthenticatedUserProfile;
  controlUiAdmin: boolean;
  release: () => void;
};

type PreparedOperatorRecoverySource = {
  snapshot: OperatorRunRecoverySnapshot;
  revalidate: () => Promise<void>;
  onSessionCompactionCommitted?: SessionSourceAssertion["onSessionCompactionCommitted"];
};

/** Authentication restoration is shared; each input owner supplies its exact live claim. */
async function restoreGatewayOperatorSnapshot(params: {
  context: GatewayRequestContext;
  assertCurrent: () => void;
  subscribeToClaim?: (revoke: () => void) => () => void;
  prepareSource: () => Promise<PreparedOperatorRecoverySource | undefined>;
}): Promise<RestoredGatewayOperatorAuthority | undefined> {
  const { context, assertCurrent } = params;
  const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
  const gatewayOwner = context.resolveGatewayContext?.() ?? context;
  let references = 1;
  const signal = new AbortController();
  const revoke = (cause?: unknown) =>
    signal.abort(
      cause instanceof GatewayOperatorRecoveryAuthorizationError
        ? new GatewayOperatorRecoveryAuthorizationError(undefined, { cause })
        : new Error("Restart recovery operator authority changed; start a new user turn.", {
            cause,
          }),
    );
  const assertLifetime = () => {
    if (references === 0) {
      throw new Error("Restart recovery operator authority is no longer active.");
    }
    signal.signal.throwIfAborted();
  };
  const subscriptions: Array<() => void> = [];
  if (params.subscribeToClaim) {
    subscriptions.push(params.subscribeToClaim(revoke));
  }
  let identity: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  const releaseHold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (--references === 0) {
        subscriptions.splice(0).forEach((release) => release());
        identity?.release();
      }
    };
  };
  const release = releaseHold();
  try {
    const prepared = await params.prepareSource();
    assertLifetime();
    assertCurrent();
    if (!prepared) {
      release();
      return undefined;
    }
    const snapshot = prepared.snapshot;
    const generationOwner = context.sharedGatewaySessionGenerationState;
    if (snapshot.sharedGeneration !== undefined) {
      if (!generationOwner || generationOwner.requiredGeneration !== snapshot.sharedGeneration) {
        throw new Error("Restart recovery authentication owner changed; start a new user turn.");
      }
      subscriptions.push(
        generationOwner.onInvalidated(
          snapshot.sharedGeneration,
          () => revoke(new GatewayOperatorRecoveryAuthorizationError()),
          snapshot.authPolicy,
        ),
      );
    }
    const device = captureGatewayDeviceRevocation(
      gatewayOwner,
      { deviceId: snapshot.device?.deviceId, role: "operator" },
      () => !signal.signal.aborted,
    );
    subscriptions.push(device.release);
    const releaseDeviceNotification = onGatewayDeviceSourceRevoked(device.isCurrent, revoke);
    if (releaseDeviceNotification) {
      subscriptions.push(releaseDeviceNotification);
    }
    let authPolicy: GatewayAuthPolicy = snapshot.authPolicy;
    let sourceConfig: OpenClawConfig | undefined;
    let sourceRevision: object | undefined;
    let sourcePublication: object | undefined;
    const assertSourcePolicy = () => {
      assertLifetime();
      const cfg = getConfig();
      const revision = readOperatorRoleConfigRevision(gatewayOwner);
      const publication = runtimeConfigPublication.current?.revision;
      if (
        !device.isCurrent() ||
        (snapshot.sharedGeneration !== undefined &&
          context.sharedGatewaySessionGenerationState !== generationOwner)
      ) {
        throw new Error("Restart recovery operator source policy changed.");
      }
      if (
        ((cfg !== sourceConfig ||
          revision !== sourceRevision ||
          publication !== sourcePublication) &&
          !isOperatorRoleSourcePolicyCurrent(
            snapshot.rolePolicy,
            sourceRolePolicy(
              resolveOperatorRolePolicyForAssignment(
                snapshot.profileId,
                snapshot.assignedRole,
                cfg,
                snapshot.githubLogin,
              ),
            ),
            snapshot.scopes,
          )) ||
        !isGatewayAuthGrantCurrent(authPolicy, cfg)
      ) {
        throw new GatewayOperatorRecoveryAuthorizationError(
          "Restart recovery operator source policy changed.",
        );
      }
      // Retain this config's issued policy only after validating the original grant.
      authPolicy = captureGatewayAuthPolicy(cfg, authPolicy);
      // The decoded admission is frozen. Reconcile it once per live owner's publication;
      // profile assignments, device lifetime, and plugin grants still check every use.
      sourceConfig = cfg;
      sourceRevision = revision;
      sourcePublication = publication;
      return cfg;
    };
    let assertPolicy = assertSourcePolicy;
    const assertRecoveryCurrent = () => {
      assertCurrent();
      return assertPolicy();
    };
    const recheck = () => {
      if (references > 0 && !signal.signal.aborted) {
        try {
          assertPolicy();
        } catch (error) {
          revoke(error);
        }
      }
    };
    // Subscribe before preparation yields: a committed downgrade remains revoked
    // even if another update restores the same role or authentication policy.
    subscriptions.push(
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === snapshot.profileId) {
          revoke(new GatewayOperatorRecoveryAuthorizationError());
        } else if (change.kind === "config" && change.context === gatewayOwner) {
          recheck();
        }
      }),
    );
    assertRecoveryCurrent();
    identity = await prepareUserProfileIdentity(snapshot.profileId);
    const profileIdentity = identity;
    let githubAccountIds: readonly number[] | undefined;
    let profileRevision: object | undefined;
    let profileFacts: ReturnType<typeof profileIdentity.readCurrentFacts>["profile"] | undefined;
    const assertFacts = () => {
      const cfg = assertSourcePolicy();
      // The bound owner still checks lifetime, settlement, and email bindings on every use.
      const revision = profileIdentity.readCurrentRevision(snapshot.aliasBindingIds);
      if (!profileFacts || revision !== profileRevision) {
        const profile = profileIdentity.readCurrentFacts(snapshot.aliasBindingIds).profile;
        if (
          profile.profileId !== snapshot.profileId ||
          profile.assignedRole !== snapshot.assignedRole ||
          (profile.githubLogin ?? null) !== snapshot.githubLogin ||
          githubAccountIds?.some((accountId) => !profile.githubAccountIds?.includes(accountId))
        ) {
          throw new GatewayOperatorRecoveryAuthorizationError(
            "Restart recovery operator identity changed.",
          );
        }
        githubAccountIds ??= profile.githubAccountIds ?? [];
        profileFacts = profile;
        profileRevision = revision;
      }
      return { cfg, profile: profileFacts };
    };
    let accessAuthority: ReturnType<typeof resumeGatewayOperatorAccessGrant>;
    assertPolicy = () => {
      try {
        const { profile, cfg } = assertFacts();
        const access = resumeGatewayOperatorAccessGrant(
          profile,
          cfg,
          snapshot.grant,
          accessAuthority,
        );
        if (access && !accessAuthority) {
          accessAuthority = access;
          const onAbort = () => revoke(access.signal.reason);
          access.signal.addEventListener("abort", onAbort, { once: true });
          subscriptions.push(() => access.signal.removeEventListener("abort", onAbort));
        }
        // The grant assertion can synchronously abort its signal.
        accessAuthority?.signal.throwIfAborted();
        // A policy callback can change committed identity/config synchronously.
        return assertFacts().cfg;
      } catch (error) {
        const failure =
          signal.signal.reason instanceof GatewayOperatorRecoveryAuthorizationError
            ? signal.signal.reason
            : error instanceof GatewayOperatorAccessDeniedError
              ? new GatewayOperatorRecoveryAuthorizationError(error.message, { cause: error })
              : error;
        revoke(failure);
        throw failure;
      }
    };
    subscriptions.push(onUserProfilesChanged(recheck));
    assertRecoveryCurrent();
    if (snapshot.device) {
      const paired = await loadPairedDevicePairingStoreRecordReadOnly(snapshot.device.deviceId);
      if (
        !isPairedDeviceTokenIdentityCurrent(paired, "operator", snapshot.device, snapshot.scopes)
      ) {
        revoke(new GatewayOperatorRecoveryAuthorizationError());
      }
    }
    assertRecoveryCurrent();
    await prepared.revalidate();
    assertRecoveryCurrent();
    const assertRestoredPolicy = Object.assign(assertRecoveryCurrent, {
      onSessionCompactionCommitted: prepared.onSessionCompactionCommitted
        ? (
            ...args: Parameters<NonNullable<SessionSourceAssertion["onSessionCompactionCommitted"]>>
          ) => {
            // The commit already checked authority. Its identity publication follows this callback.
            if (references === 0) {
              throw new Error("Restart recovery operator authority is no longer active.");
            }
            signal.signal.throwIfAborted();
            try {
              prepared.onSessionCompactionCommitted?.(...args);
            } catch (error) {
              revoke(error);
              throw error;
            }
          }
        : undefined,
    });
    const live = captureChannelOperatorRunAuthority({
      profileId: snapshot.profileId,
      assignedRole: snapshot.assignedRole,
      githubLogin: snapshot.githubLogin,
      scopes: snapshot.scopes,
      gatewayAccessGrant: snapshot.grant,
      getRuntimeConfig: getConfig,
      assertCurrent: assertPolicy,
      signal: signal.signal,
    });
    const originalModels = snapshot.modelPolicy
      ? restoreOperatorModelPolicySnapshot(snapshot.modelPolicy)
      : undefined;
    const retainPolicy = () => {
      assertPolicy();
      references += 1;
      return releaseHold();
    };
    const policyAuthority = createAdmittedRunOperatorAuthority({
      ...live,
      signal: signal.signal,
      recoverySnapshot: snapshot,
      retain: retainPolicy,
      get modelPolicy() {
        return intersectOperatorRunModelPolicy(originalModels, live.modelPolicy);
      },
    });
    const authority = createAdmittedRunOperatorAuthority({
      ...policyAuthority,
      assertCurrent: assertRestoredPolicy,
      retain: () => {
        assertCurrent();
        return retainPolicy();
      },
      get modelPolicy() {
        return policyAuthority.modelPolicy;
      },
    });
    bindGatewayOperatorContinuationAuthority(authority, policyAuthority);
    authority.assertCurrent();
    const profile = readResidentUserProfileRevision(snapshot.profileId, profileCatalogPath({}));
    if (!profile) {
      throw new Error("Restart recovery operator profile is unavailable.");
    }
    const { id, ...display } = projectUserProfileDisplay(profile);
    return {
      authority,
      assertPolicyCurrent: () => {
        assertPolicy();
      },
      authenticatedUserProfile: { profileId: id, ...display, updatedAt: profile.updated_at },
      controlUiAdmin: snapshot.controlUiAdmin,
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

/** Restore owner-held continuation evidence through the shared authentication owner. */
export async function restoreGatewayOperatorSource(params: {
  snapshot: OperatorRunRecoverySnapshot;
  target: Pick<OperatorRecoveryTarget, "agentId" | "sessionKey" | "sessionId">;
  context: GatewayRequestContext;
  assertCurrent: () => void;
  prepareCurrent?: () => Promise<void>;
}): Promise<RestoredGatewayOperatorAuthority> {
  const target = { ...params.target };
  const restored = await restoreGatewayOperatorSnapshot({
    context: params.context,
    assertCurrent: params.assertCurrent,
    subscribeToClaim: (revoke) =>
      onSessionIdentityMutation((mutation) => {
        if (
          mutation.agentId === target.agentId &&
          (mutation.previous.sessionId === target.sessionId ||
            mutation.previous.sessionKeys.includes(target.sessionKey))
        ) {
          revoke();
        }
      }),
    prepareSource: async () => ({
      snapshot: params.snapshot,
      revalidate: async () => {
        await params.prepareCurrent?.();
      },
    }),
  });
  if (!restored) {
    throw new Error("Operator continuation recovery source is unavailable.");
  }
  return restored;
}

function assertRestartClaim(
  entry: InternalSessionEntry | undefined,
  target: OperatorRecoveryTarget,
): asserts entry is InternalSessionEntry {
  const reservation = entry?.mainRestartRecovery?.reservation;
  if (
    !entry ||
    entry.sessionId !== target.sessionId ||
    entry.restartRecoveryDeliveryRunId !== target.recoveryRunId ||
    entry.restartRecoveryDeliverySourceRunId !== target.sourceRunId ||
    (reservation &&
      (reservation.runId !== target.recoveryRunId ||
        reservation.lifecycleGeneration !== getAgentEventLifecycleGeneration()))
  ) {
    throw new GatewayOperatorRecoveryOwnershipError(
      "Restart recovery source no longer owns this input.",
    );
  }
}

/** Restore requested facts and authority from the same final revalidated private row. */
export async function restoreGatewayRunRecovery(params: {
  target: OperatorRecoveryTarget;
  context: GatewayRequestContext;
  assertCurrent: () => void;
  restoreOperator: boolean;
  restoreRequester: boolean;
}): Promise<{
  operator?: RestoredGatewayOperatorAuthority;
  requesterOrigin?: RequesterOrigin;
  parentSource?: { source: SessionSourceAssertion; release: () => void };
}> {
  const target = { ...params.target };
  let entry: InternalSessionEntry | undefined;
  const read = async () => {
    params.assertCurrent();
    const current = await readSessionEntryReadOnlyInWorker(target, params.assertCurrent);
    params.assertCurrent();
    assertRestartClaim(current, target);
    entry = current;
    return current;
  };
  let operator: RestoredGatewayOperatorAuthority | undefined;
  let expectedCompaction: { previousSessionId: string; sessionId: string } | undefined;
  if (params.restoreOperator) {
    operator = await restoreGatewayOperatorSnapshot({
      context: params.context,
      assertCurrent: params.assertCurrent,
      subscribeToClaim: (revoke) =>
        onSessionIdentityMutation((mutation) => {
          if (
            expectedCompaction &&
            mutation.kind === "replace" &&
            mutation.agentId === target.agentId &&
            mutation.previous.sessionId === expectedCompaction.previousSessionId &&
            mutation.current.sessionId === expectedCompaction.sessionId &&
            mutation.previous.sessionKeys.length === 1 &&
            mutation.previous.sessionKeys[0] === target.sessionKey &&
            mutation.current.sessionKeys.length === 1 &&
            mutation.current.sessionKeys[0] === target.sessionKey
          ) {
            expectedCompaction = undefined;
            return;
          }
          if (
            mutation.agentId === target.agentId &&
            (mutation.previous.sessionId === target.sessionId ||
              mutation.previous.sessionKeys.includes(target.sessionKey))
          ) {
            revoke();
          }
        }),
      prepareSource: async () => {
        const current = await read();
        if (!current.restartRecoveryOperatorSource) {
          return undefined;
        }
        let source = decodeGatewayOperatorRecoverySource(current.restartRecoveryOperatorSource);
        const assertSource = (value: InternalSessionEntry) => {
          if (
            value.lifecycleRevision !== source.lifecycleRevision ||
            source.agentId !== target.agentId ||
            source.sessionKey !== target.sessionKey ||
            source.sessionId !== target.sessionId ||
            source.sourceRunId !== target.sourceRunId ||
            !isDeepStrictEqual(value.restartRecoveryOperatorSource, source)
          ) {
            throw new GatewayOperatorRecoveryOwnershipError();
          }
        };
        assertSource(current);
        return {
          snapshot: source.snapshot,
          revalidate: async () => assertSource(await read()),
          onSessionCompactionCommitted: (transition, committed) => {
            if (
              target.sessionId === transition.current.sessionId &&
              source.lifecycleRevision === transition.current.lifecycleRevision
            ) {
              // Composed source assertions can deliver the same committed fact more than once.
              assertRestartClaim(committed, target);
              assertSource(committed);
              return;
            }
            const next = { ...source, sessionId: transition.current.sessionId };
            const successor = { ...target, sessionId: transition.current.sessionId };
            assertRestartClaim(committed, successor);
            if (
              !transition.previous ||
              transition.previous.sessionId !== target.sessionId ||
              transition.previous.lifecycleRevision !== source.lifecycleRevision ||
              transition.current.lifecycleRevision !== source.lifecycleRevision ||
              committed.lifecycleRevision !== source.lifecycleRevision ||
              !isDeepStrictEqual(committed.restartRecoveryOperatorSource, next)
            ) {
              throw new GatewayOperatorRecoveryOwnershipError();
            }
            expectedCompaction = {
              previousSessionId: target.sessionId,
              sessionId: successor.sessionId,
            };
            target.sessionId = successor.sessionId;
            source = next;
          },
        };
      },
    });
  } else {
    await read();
  }
  try {
    params.assertCurrent();
    assertRestartClaim(entry, target);
    const requesterOrigin = params.restoreRequester
      ? readRestartRecoveryRequesterSource({ ...target, entry })
      : undefined;
    const parentSource = await prepareRestartRecoveryParentSource({
      ...params,
      target,
      entry,
      requesterOrigin,
      operatorSource: operator ? { ...target, authority: operator.authority } : undefined,
    });
    if (operator) {
      recoverySources.set(operator.authority, {
        target,
        source: Object.freeze({
          controlUiAdmin: operator.controlUiAdmin,
          localOperator: operator.authority.recoverySnapshot?.localOperator === true,
        }),
      });
    }
    return { operator, requesterOrigin, parentSource };
  } catch (error) {
    operator?.release();
    throw error;
  }
}

/** A queued native launch reuses its original authenticated source, never profile attribution. */
export async function restoreGatewayQueuedOperatorRecovery(params: {
  source: unknown;
  context: GatewayRequestContext;
  assertCurrent: () => void;
}): Promise<Pick<RestoredGatewayOperatorAuthority, "authority" | "controlUiAdmin" | "release">> {
  params.assertCurrent();
  const source = decodeQueuedOperatorRecoverySource(params.source);
  if (source.kind === "unavailable") {
    throw new Error("Queued operator authority cannot be recovered; submit a new request.");
  }
  if (source.kind === "gateway") {
    const restored = await restoreGatewayOperatorSnapshot({
      context: params.context,
      assertCurrent: params.assertCurrent,
      prepareSource: async () => ({
        snapshot: source.snapshot,
        revalidate: async () => params.assertCurrent(),
      }),
    });
    if (!restored) {
      throw new Error("Queued operator recovery source is unavailable.");
    }
    return restored;
  }
  const snapshot = source.snapshot;
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const prepared = await prepareCommandOwnerAuthority(getConfig(), snapshot.reference);
  params.assertCurrent();
  const profile = prepared.operatorProfile;
  if (!profile || profile.profileId !== snapshot.profileId || !prepared.isCurrent(getConfig())) {
    throw new Error("Queued channel operator authority changed; submit a new request.");
  }
  let references = 1;
  const assertCurrent = () => {
    if (references === 0) {
      throw new Error("Queued channel operator authority is no longer active.");
    }
    params.assertCurrent();
    if (!prepared.isCurrent(getConfig())) {
      throw new Error("Queued channel operator authority changed; submit a new request.");
    }
  };
  const live = captureChannelOperatorRunAuthority({
    ...profile,
    recoveryReference: snapshot.reference,
    scopes: intersectOperatorScopes(snapshot.scopes, profile.scopes),
    getRuntimeConfig: getConfig,
    assertCurrent,
    signal: prepared.signal,
  });
  // Every hold keeps the live revocation subscribed, so retained work settles on revocation.
  const releaseHold = () => {
    const releaseLive = live.retain?.();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        references -= 1;
        releaseLive?.();
      }
    };
  };
  const release = releaseHold();
  const originalModels = snapshot.modelPolicy
    ? restoreOperatorModelPolicySnapshot(snapshot.modelPolicy)
    : undefined;
  try {
    const authority = createAdmittedRunOperatorAuthority({
      ...live,
      channelRecoverySource: { reference: snapshot.reference, modelPolicy: originalModels },
      retain: () => {
        if (references === 0) {
          throw new Error("Queued channel operator authority is no longer active.");
        }
        references += 1;
        try {
          // The live check latches a refusal into the signal every retained holder observes.
          return releaseHold();
        } catch (error) {
          references -= 1;
          throw error;
        }
      },
      get modelPolicy() {
        return intersectOperatorRunModelPolicy(originalModels, live.modelPolicy);
      },
    });
    authority.assertCurrent();
    return { authority, controlUiAdmin: false, release };
  } catch (error) {
    release();
    throw error;
  }
}
