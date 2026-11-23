import { isNativeAppUiClient } from "../../packages/gateway-protocol/src/client-info.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { bindSharedGatewayOwnerRunAuthority } from "../agents/harness/host-private-capabilities.js";
import {
  prepareOperatorModelPolicy,
  readOperatorModelPolicyMembership,
  type PreparedOperatorModelPolicy,
} from "../agents/operator-model-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOperatorAuthorityInactiveError } from "../infra/operator-authority-error.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import {
  intersectOperatorScopes,
  resolveMissingOperatorScope,
  roleScopesAllow,
} from "../shared/operator-scope-compat.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { UserChannelAuthorizationReference } from "../state/user-profiles.types.js";
import { isBrowserOperatorUiClient, isWebchatClient } from "../utils/message-channel.js";
import {
  bindGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
  readGatewayDeviceSourceIdentity,
  readGatewayDeviceReconnectSourceIdentity,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  openclawIdSubjectRolePolicy,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { operatorRoleSubject } from "./operator-role-enforcement.js";
import {
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import { captureGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/shared-types.js";

type OperatorSource = {
  owners: readonly [
    gateway: object,
    resolver: GatewayRequestContext["resolveGatewayContext"],
    config: GatewayRequestContext["getRuntimeConfig"],
    device: object | undefined,
    access: object | null | undefined,
    ingress: object | undefined,
  ];
  membership: string | undefined;
  token: object;
  references: number;
};

// Comparison records live only while captured work retains their original authority.
type OperatorSourceBucket = {
  owner: object;
  entries: Set<OperatorSource>;
};
const operatorSources = new WeakMap<object, OperatorSourceBucket>();
function getOperatorSources(owner: object): OperatorSourceBucket {
  let sources = operatorSources.get(owner);
  if (!sources) {
    sources = { owner, entries: new Set() };
    operatorSources.set(owner, sources);
  }
  return sources;
}

/** A captured transport principal keeps its source's comparison identity, not new authority. */
export function transferGatewayOperatorSourceIdentity(
  source: GatewayClient,
  target: GatewayClient,
): void {
  operatorSources.set(target, getOperatorSources(source));
}

function retainOperatorSource(
  client: GatewayClient,
  owners: OperatorSource["owners"],
  membership: string | undefined,
  callerGuard: (() => boolean) | undefined,
) {
  const clientSources = getOperatorSources(client);
  const deviceSource = readGatewayDeviceReconnectSourceIdentity(callerGuard, clientSources.owner);
  // A reconnect joins comparison records, never either request's live authority.
  const sources = deviceSource ? getOperatorSources(deviceSource).entries : clientSources.entries;
  let source =
    membership === undefined
      ? undefined
      : [...sources].find(
          (entry) =>
            entry.membership === membership &&
            entry.owners.every((owner, index) => owner === owners[index]),
        );
  if (!source) {
    source = { owners, membership, token: Object.freeze({}), references: 0 };
    sources.add(source);
  }
  const retained = source;
  const bucket = sources;
  retained.references += 1;
  return {
    token: retained.token,
    release: () => {
      if (--retained.references === 0) {
        bucket.delete(retained);
      }
    },
  };
}

function prepareRunRolePolicy(
  role: ReturnType<typeof sourceRolePolicy>,
): AdmittedRunOperatorAuthority["rolePolicy"] {
  return role
    ? {
        sessionAccessCap: role.sessions.others,
        sandboxRequired: role.sandbox === "required",
        agents: role.agents,
        accessPrograms: role.accessPrograms,
      }
    : undefined;
}

export function intersectOperatorRunModelPolicy(
  original: PreparedOperatorModelPolicy | undefined,
  current: PreparedOperatorModelPolicy | undefined,
): PreparedOperatorModelPolicy | undefined {
  return original &&
    current &&
    readOperatorModelPolicyMembership(original) !== readOperatorModelPolicyMembership(current)
    ? Object.freeze({
        models: Object.freeze(current.models.filter(original.allows)),
        allows: (ref: Parameters<typeof original.allows>[0]) =>
          original.allows(ref) && current.allows(ref),
      })
    : (current ?? original);
}

/** Admits a linked channel requester once while retaining explicit lifecycle cancellation. */
export function captureChannelOperatorRunAuthority(input: {
  profileId: string;
  canonicalIdentity: AdmittedRunOperatorAuthority["canonicalIdentity"];
  openclawIdAccountIds?: readonly string[];
  recoveryReference?: UserChannelAuthorizationReference;
  openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
  assignedRole: string | null;
  githubLogin?: string | null;
  scopes: readonly string[];
  gatewayAccessGrant: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
  getRuntimeConfig: () => OpenClawConfig;
  signal?: AbortSignal;
}): AdmittedRunOperatorAuthority {
  const params = { ...input };
  const initialConfig = params.getRuntimeConfig();
  const metadata = getProcessGatewayPluginMetadataSnapshot();
  const role = structuredClone(
    openclawIdSubjectRolePolicy(params.openclawIdPrincipal, () =>
      resolveOperatorRolePolicyForAssignment(
        params.profileId,
        params.assignedRole,
        initialConfig,
        params.githubLogin ?? null,
        operatorRoleSubject(params),
      ),
    ),
  );
  const modelPolicy = prepareOperatorModelPolicy({
    cfg: initialConfig,
    policy: role?.modelPolicy,
    manifestPlugins: metadata ?? [],
  });
  return createAdmittedRunOperatorAuthority({
    profileId: params.profileId,
    canonicalIdentity: params.canonicalIdentity,
    openclawIdPrincipal: params.openclawIdPrincipal,
    channelRecoverySource: params.recoveryReference
      ? { reference: params.recoveryReference, modelPolicy }
      : undefined,
    scopes: params.scopes,
    rolePolicy: prepareRunRolePolicy(sourceRolePolicy(role)),
    gatewayAccessGrant: params.gatewayAccessGrant,
    assertCurrent: () => params.signal?.throwIfAborted(),
    signal: params.signal,
    readCurrentRoleFacts: () => ({
      assignedRole: params.assignedRole,
      openclawIdAccountIds: params.openclawIdAccountIds,
      githubLogin: params.githubLogin ?? null,
      policy: role,
    }),
    modelPolicy,
  });
}

export type GatewayOperatorRunAdmissionInput = {
  client: GatewayClient | null;
  agentId?: string;
  context: Pick<
    GatewayRequestContext,
    "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
  >;
  hasCurrentClientAuthority?: () => boolean;
  sourceAuthority?: Readonly<{
    assertCurrent: () => void;
    signal?: AbortSignal;
    gatewayAccessGrant?: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
    /** Transfer the prepared principal/session facts to this admitted lifetime. */
    release?: () => void;
  }> | null;
  /** Additional request lifetime; never replaces the authenticated access grant. */
  invocationAuthority?: Readonly<{
    assertCurrent: () => void;
    signal?: AbortSignal;
    release?: () => void;
  }>;
};

export type PreparedGatewayOperatorRunAuthority = {
  authority: AdmittedRunOperatorAuthority;
  release: () => void;
};

/** Admits the initial requester once; accepted work keeps its policy until its lifetime ends. */
export async function prepareGatewayOperatorRunAuthority(
  input: GatewayOperatorRunAdmissionInput,
): Promise<PreparedGatewayOperatorRunAuthority | undefined> {
  const params = { ...input };
  const inherited = params.client?.internal?.operatorRunAuthority;
  if (inherited !== undefined) {
    assertAdmittedRunOperatorAuthority(inherited);
    inherited.assertCurrent();
    const scopes = intersectOperatorScopes(inherited.scopes, params.client?.connect.scopes ?? []);
    const authority = roleScopesAllow({
      role: "operator",
      requestedScopes: inherited.scopes,
      allowedScopes: scopes,
    })
      ? inherited
      : createAdmittedRunOperatorAuthority({
          ...inherited,
          scopes,
          get modelPolicy() {
            return inherited.modelPolicy;
          },
        });
    bindGatewayDeviceRevocation(authority.assertCurrent, inherited.assertCurrent);
    return { authority, release: inherited.retain?.() ?? (() => {}) };
  }
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const client = params.client;
  const ingressPrincipal = client?.internal?.remoteIngressPrincipal;
  // An HTTP adapter carries a host-authenticated OCID source and its current request check.
  const isHttpOwner = () =>
    client?.internal?.syntheticClient === true &&
    client.internal.openclawIdPrincipal?.kind === "owner" &&
    client.internal.openclawIdPrincipal.authority !== undefined &&
    client.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID &&
    params.hasCurrentClientAuthority?.() === true &&
    isOpenClawIdTunnelPrincipalCurrent(client.internal.openclawIdPrincipal);
  // An OpenClaw ID owner device whose account is linked to a personal profile (OCF-510) is
  // the owner, attributed to that person; only its real tunnel socket carries that subject.
  const isLinkedOwnerDevice = (currentActor: typeof actor) =>
    currentActor?.kind === "system" &&
    client?.internal?.openclawIdPrincipal?.kind === "owner" &&
    !client.internal.remoteIngressPrincipal &&
    !client.internal.syntheticClient &&
    Boolean(client.connId) &&
    Boolean(client.authenticatedUserProfile?.profileId) &&
    isOpenClawIdTunnelPrincipalCurrent(client.internal.openclawIdPrincipal);
  // Other owner subjects require a real socket or the host-bound ingress grant.
  // Autonomous/synthetic system callers must not acquire the owner profile.
  // Ephemeral shared-secret sockets attest the owner without display attribution.
  const isAuthenticatedOwner = (currentActor: typeof actor) =>
    client?.internal !== undefined &&
    (client.internal.authenticatedOperator === true || isHttpOwner()) &&
    (currentActor === undefined || currentActor.kind === "system") &&
    client.connect.role === "operator" &&
    (isHttpOwner() ||
      Boolean(client.connId) ||
      (ingressPrincipal !== undefined &&
        client.internal.remoteIngressPrincipal === ingressPrincipal &&
        ingressPrincipal.operatorRoleActor.kind === "system" &&
        ingressPrincipal.authenticatedUserProfile.profileId === GATEWAY_OWNER_PROFILE_ID)) &&
    !client.invalidated &&
    !client.connectionSignal?.aborted &&
    (!client.internal.syntheticClient || isHttpOwner()) &&
    !client.internal.agentRuntimeIdentity &&
    !client.internal.agentToolCaller &&
    (client.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID ||
      isLinkedOwnerDevice(currentActor) ||
      (currentActor?.kind === "system" &&
        !client.authenticatedUserProfile &&
        !client.authenticatedUserId &&
        client.usesSharedGatewayAuth === true &&
        Boolean(client.sharedGatewaySessionGeneration) &&
        (client.authPolicy?.authMethod === "token" ||
          client.authPolicy?.authMethod === "password")));
  const authenticatedOwner = isAuthenticatedOwner(actor);
  if (!client || (actor?.kind !== "operator" && !authenticatedOwner)) {
    return undefined;
  }
  const openclawIdPrincipal = client.internal?.openclawIdPrincipal
    ? structuredClone(client.internal.openclawIdPrincipal)
    : undefined;
  const profileId =
    actor?.kind === "operator"
      ? actor.profileId
      : isLinkedOwnerDevice(actor) && client.authenticatedUserProfile
        ? client.authenticatedUserProfile.profileId
        : GATEWAY_OWNER_PROFILE_ID;
  const connectionId = client.connId;
  const connectionSignal = client.connectionSignal;
  const releaseDevice = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const capturedAt = performance.now();
  const isSourceCurrent = readGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority);
  const resolveGatewayContext = params.context.resolveGatewayContext;
  const gatewayContext = resolveGatewayContext?.();
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const isGatewayCurrent = () =>
    !resolveGatewayContext ||
    (gatewayContext !== undefined && resolveGatewayContext() === gatewayContext);
  const sourceAuthority =
    params.sourceAuthority !== undefined
      ? params.sourceAuthority
      : client.internal?.operatorAccessAuthority;
  const sourceAuthorities = [sourceAuthority, ingressPrincipal];
  const scopes = [...(client.connect.scopes ?? [])];
  const sourceOwners: OperatorSource["owners"] = [
    gatewayContext ?? params.context,
    resolveGatewayContext,
    getConfig,
    readGatewayDeviceSourceIdentity(params.hasCurrentClientAuthority) ??
      (params.hasCurrentClientAuthority ? {} : undefined),
    sourceAuthority,
    ingressPrincipal,
  ];
  let releaseSource: (() => void) | undefined;
  let references = 1;
  let preparedProfile: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  const assertProfileCurrent = () => {
    try {
      const profile = preparedProfile?.readCurrentProfile();
      if (!profile || profile.profileId !== profileId) {
        throw new Error("operator profile is unavailable");
      }
      return profile;
    } catch (error) {
      throw new Error("operator source identity changed; start a new request", { cause: error });
    }
  };
  const resolveAdmissionRole = (
    assignedRole: string | null,
    githubLogin: string | null,
    cfg: OpenClawConfig,
  ) =>
    openclawIdSubjectRolePolicy(openclawIdPrincipal, () =>
      resolveOperatorRolePolicyForAssignment(
        profileId,
        assignedRole,
        cfg,
        githubLogin,
        operatorRoleSubject(assertProfileCurrent()),
      ),
    );
  const assertCurrent = () => {
    if (references === 0) {
      throw createOperatorAuthorityInactiveError("closure-released", "before-sources", capturedAt);
    }
    params.invocationAuthority?.signal?.throwIfAborted();
    params.invocationAuthority?.assertCurrent();
    params.invocationAuthority?.signal?.throwIfAborted();
    if (references === 0) {
      throw createOperatorAuthorityInactiveError("closure-released", "after-sources", capturedAt);
    }
  };
  const releaseHold = () => {
    let released = false;
    return () => {
      if (!released) {
        released = true;
        if (--references === 0) {
          releaseSource?.();
          releaseSource = undefined;
          preparedProfile?.release();
          try {
            params.sourceAuthority?.release?.();
          } finally {
            try {
              params.invocationAuthority?.release?.();
            } finally {
              releaseDevice?.();
            }
          }
        }
      }
    };
  };
  const release = releaseHold();
  const assertAdmissionCurrent = () => {
    const currentActor = resolveGatewayOperatorRoleActor(params.client);
    const originalActorCurrent = authenticatedOwner
      ? isAuthenticatedOwner(currentActor) &&
        client.connId === connectionId &&
        client.connectionSignal === connectionSignal
      : currentActor?.kind === "operator" && currentActor.profileId === profileId;
    if (
      references === 0 ||
      params.client !== client ||
      !originalActorCurrent ||
      params.hasCurrentClientAuthority?.() === false ||
      isSourceCurrent?.() === false ||
      !isGatewayCurrent() ||
      (openclawIdPrincipal && !isOpenClawIdTunnelPrincipalCurrent(openclawIdPrincipal)) ||
      !roleScopesAllow({
        role: "operator",
        requestedScopes: scopes,
        allowedScopes: client.connect.scopes ?? [],
      })
    ) {
      throw new Error("Gateway caller authority is no longer active.");
    }
  };
  try {
    assertCurrent();
    assertAdmissionCurrent();
    preparedProfile = await prepareUserProfileIdentity(profileId);
    for (const authority of sourceAuthorities) {
      authority?.signal?.throwIfAborted();
      authority?.assertCurrent();
      authority?.signal?.throwIfAborted();
    }
    const capturedConfig = getConfig();
    const capturedProfile = assertProfileCurrent();
    const capturedRole = structuredClone(
      resolveAdmissionRole(
        capturedProfile.assignedRole,
        capturedProfile.githubLogin ?? null,
        capturedConfig,
      ),
    );
    if (capturedRole && resolveMissingOperatorScope(scopes, capturedRole.scopes) !== null) {
      throw new Error("Your operator role changed; reconnect before continuing.");
    }
    const capturedSourcePolicy = sourceRolePolicy(capturedRole);
    const modelPolicy = prepareOperatorModelPolicy({
      cfg: capturedConfig,
      policy: capturedRole?.modelPolicy,
      manifestPlugins: getProcessGatewayPluginMetadataSnapshot() ?? [],
    });
    const capturedModelMembership = readOperatorModelPolicyMembership(modelPolicy);
    const source = retainOperatorSource(
      client,
      sourceOwners,
      capturedModelMembership,
      params.hasCurrentClientAuthority,
    );
    releaseSource = source.release;
    const grant =
      sourceAuthority === null || (sourceAuthority === undefined && authenticatedOwner)
        ? null
        : sourceAuthority?.gatewayAccessGrant;
    // Pin the admitted grant independently of its source's mutable reference.
    const admission = {
      profileId,
      openclawIdPrincipal,
      scopes,
      gatewayAccessGrant: grant ? Object.freeze({ ...grant }) : grant,
      assertCurrent,
    };
    const {
      snapshot: recoverySnapshot,
      unavailableReason: recoverySnapshotUnavailableReason,
      device,
      authPolicy,
      sharedGeneration,
    } = await captureGatewayOperatorRecoverySnapshot({
      client,
      authority: admission,
      modelPolicy,
      identity: preparedProfile,
      config: getConfig(),
    });
    assertCurrent();
    assertAdmissionCurrent();
    const authority = createAdmittedRunOperatorAuthority({
      ...admission,
      canonicalIdentity: { profileId: capturedProfile.profileId },
      clientId: client.internal?.syntheticClient ? undefined : client.connect.client.id,
      recoverySnapshot,
      recoverySnapshotUnavailableReason,
      device,
      deviceScopeCeiling: client.internal?.operatorDeviceScopeCeiling,
      authPolicy,
      sharedGeneration,
      ingress: ingressPrincipal && {
        bindingId: ingressPrincipal.bindingId,
        pluginId: ingressPrincipal.pluginId,
        audienceId: ingressPrincipal.audienceId,
        principal: ingressPrincipal.principal,
        signal: ingressPrincipal.signal,
        scopeCeiling: ingressPrincipal.scopes,
      },
      rolePolicy: prepareRunRolePolicy(capturedSourcePolicy),
      readCurrentRoleFacts: () => ({
        assignedRole: capturedProfile.assignedRole,
        githubLogin: capturedProfile.githubLogin ?? null,
        policy: capturedRole,
      }),
      source: source.token,
      invocation: params.invocationAuthority,
      signal: params.invocationAuthority?.signal,
      retain: () => {
        assertCurrent();
        references += 1;
        return releaseHold();
      },
      modelPolicy,
    });
    bindGatewayDeviceRevocation(authority.assertCurrent, params.hasCurrentClientAuthority);
    if (
      authenticatedOwner &&
      client.usesSharedGatewayAuth === true &&
      client.sharedGatewaySessionGeneration &&
      (isBrowserOperatorUiClient(client.connect.client) ||
        isWebchatClient(client.connect.client) ||
        isNativeAppUiClient(client.connect.client))
    ) {
      // The handshake owns the credential/generation checks, including device
      // reconnects bound to that shared credential. The profile name grants nothing.
      bindSharedGatewayOwnerRunAuthority(authority);
    }
    return { authority, release };
  } catch (error) {
    release();
    throw error;
  }
}
