import { isDeepStrictEqual } from "node:util";
import {
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { restoreOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { isPairedDeviceTokenIdentityCurrent } from "../infra/device-pairing-identity.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "../infra/device-pairing-store-readonly.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { isGatewayAuthGrantCurrent } from "./auth-policy.js";
import {
  captureGatewayDeviceRevocation,
  onGatewayDeviceSourceRevoked,
} from "./device-revocation.js";
import { resumeGatewayOperatorAccessGrant } from "./operator-access-policy.js";
import {
  onOperatorRolePolicyChanged,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import {
  captureChannelOperatorRunAuthority,
  intersectOperatorRunModelPolicy,
} from "./operator-run-authority.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

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

/** Re-admit the exact durable source under current policy; never revive an old run capability. */
export async function restoreGatewayOperatorRecovery(params: {
  target: OperatorRecoveryTarget;
  context: GatewayRequestContext;
  assertCurrent: () => void;
}): Promise<
  | { authority: AdmittedRunOperatorAuthority; controlUiAdmin: boolean; release: () => void }
  | undefined
> {
  const target = { ...params.target };
  const { context, assertCurrent } = params;
  const getConfig = context.getCommittedRuntimeConfig ?? context.getRuntimeConfig;
  const gatewayOwner = context.resolveGatewayContext?.() ?? context;
  let references = 1;
  const signal = new AbortController();
  const revoke = (cause?: unknown) =>
    signal.abort(
      new Error("Restart recovery operator authority changed; start a new user turn.", { cause }),
    );
  const assertOwner = () => {
    if (references === 0) {
      throw new Error("Restart recovery operator authority is no longer active.");
    }
    signal.signal.throwIfAborted();
    assertCurrent();
  };
  const subscriptions: Array<() => void> = [
    onSessionIdentityMutation((mutation) => {
      if (
        mutation.agentId === target.agentId &&
        (mutation.previous.sessionId === target.sessionId ||
          mutation.previous.sessionKeys.includes(target.sessionKey))
      ) {
        revoke();
      }
    }),
  ];
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
    const read = () => readSessionEntryReadOnlyInWorker(target, assertOwner);
    const entry = await read();
    if (!entry?.restartRecoveryOperatorSource) {
      release();
      return undefined;
    }
    const source = decodeGatewayOperatorRecoverySource(entry.restartRecoveryOperatorSource);
    const assertClaim = (current: InternalSessionEntry | undefined) => {
      const reservation = current?.mainRestartRecovery?.reservation;
      if (
        !current ||
        current.sessionId !== target.sessionId ||
        current.lifecycleRevision !== source.lifecycleRevision ||
        current.restartRecoveryDeliveryRunId !== target.recoveryRunId ||
        current.restartRecoveryDeliverySourceRunId !== target.sourceRunId ||
        (reservation &&
          (reservation.runId !== target.recoveryRunId ||
            reservation.lifecycleGeneration !== getAgentEventLifecycleGeneration())) ||
        source.agentId !== target.agentId ||
        source.sessionKey !== target.sessionKey ||
        source.sessionId !== target.sessionId ||
        source.sourceRunId !== target.sourceRunId ||
        !isDeepStrictEqual(current.restartRecoveryOperatorSource, source)
      ) {
        throw new Error("Restart recovery operator source no longer owns this input.");
      }
    };
    assertClaim(entry);
    const snapshot = source.snapshot;
    const generationOwner = context.sharedGatewaySessionGenerationState;
    if (snapshot.sharedGeneration !== undefined) {
      if (!generationOwner || generationOwner.requiredGeneration !== snapshot.sharedGeneration) {
        throw new Error("Restart recovery authentication owner changed; start a new user turn.");
      }
      subscriptions.push(
        generationOwner.onInvalidated(snapshot.sharedGeneration, revoke, snapshot.authPolicy),
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
    const assertSourcePolicy = () => {
      assertOwner();
      const cfg = getConfig();
      const role = resolveOperatorRolePolicyForAssignment(
        snapshot.profileId,
        snapshot.assignedRole,
        cfg,
        snapshot.githubLogin,
      );
      if (
        !device.isCurrent() ||
        !isDeepStrictEqual(sourceRolePolicy(role), snapshot.rolePolicy) ||
        !isGatewayAuthGrantCurrent(snapshot.authPolicy, cfg) ||
        (snapshot.sharedGeneration !== undefined &&
          context.sharedGatewaySessionGenerationState !== generationOwner)
      ) {
        throw new Error("Restart recovery operator source policy changed.");
      }
      return cfg;
    };
    let assertPolicy = assertSourcePolicy;
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
          revoke();
        } else if (change.kind === "config" && change.context === gatewayOwner) {
          recheck();
        }
      }),
    );
    assertSourcePolicy();
    identity = await prepareUserProfileIdentity(snapshot.profileId);
    const profileIdentity = identity;
    const assertFacts = () => {
      const cfg = assertSourcePolicy();
      const profile = profileIdentity.readCurrentFacts(snapshot.aliasBindingIds).profile;
      if (
        profile.profileId !== snapshot.profileId ||
        profile.assignedRole !== snapshot.assignedRole ||
        (profile.githubLogin ?? null) !== snapshot.githubLogin
      ) {
        throw new Error("Restart recovery operator identity changed.");
      }
      return { cfg, profile };
    };
    let accessAuthority: ReturnType<typeof resumeGatewayOperatorAccessGrant>;
    assertPolicy = () => {
      try {
        const { profile, cfg } = assertFacts();
        const access = resumeGatewayOperatorAccessGrant(profile, cfg, snapshot.grant);
        if (access && !accessAuthority) {
          accessAuthority = access;
          const onAbort = () => revoke(access.signal.reason);
          access.signal.addEventListener("abort", onAbort, { once: true });
          subscriptions.push(() => access.signal.removeEventListener("abort", onAbort));
        }
        // Retain the first exact resumed owner before recovery yields. Later
        // policy checks cannot replace a revoked source with a fresh authority.
        accessAuthority?.signal.throwIfAborted();
        accessAuthority?.assertCurrent();
        accessAuthority?.signal.throwIfAborted();
        // A policy callback can change committed identity/config synchronously.
        return assertFacts().cfg;
      } catch (error) {
        revoke(error);
        throw error;
      }
    };
    subscriptions.push(onUserProfilesChanged(recheck));
    assertPolicy();
    if (snapshot.device) {
      const paired = await loadPairedDevicePairingStoreRecordReadOnly(snapshot.device.deviceId);
      if (
        !isPairedDeviceTokenIdentityCurrent(paired, "operator", snapshot.device, snapshot.scopes)
      ) {
        revoke();
      }
      assertPolicy();
    }
    assertPolicy();
    assertClaim(await read());
    assertPolicy();
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
    const authority = createAdmittedRunOperatorAuthority({
      ...live,
      signal: signal.signal,
      recoverySnapshot: snapshot,
      retain: () => {
        assertPolicy();
        references += 1;
        return releaseHold();
      },
      get modelPolicy() {
        return intersectOperatorRunModelPolicy(originalModels, live.modelPolicy);
      },
    });
    authority.assertCurrent();
    recoverySources.set(authority, {
      target,
      source: Object.freeze({
        controlUiAdmin: snapshot.controlUiAdmin,
        localOperator: snapshot.localOperator,
      }),
    });
    return { authority, controlUiAdmin: snapshot.controlUiAdmin, release };
  } catch (error) {
    release();
    throw error;
  }
}
