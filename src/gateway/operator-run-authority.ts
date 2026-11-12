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
import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createOperatorAuthorityInactiveError } from "../infra/operator-authority-error.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  intersectOperatorScopes,
  resolveMissingOperatorScope,
  roleScopesAllow,
} from "../shared/operator-scope-compat.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import type { UserChannelAuthorizationReference } from "../state/user-profiles.types.js";
import { isBrowserOperatorUiClient, isWebchatClient } from "../utils/message-channel.js";
import { createChannelOperatorRevocation } from "./channel-operator-revocation.js";
import {
  onGatewayDeviceSourceRevoked,
  readGatewayDeviceSourceAuthority,
  readGatewayDeviceSourceIdentity,
  readGatewayDeviceReconnectSourceIdentity,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  openclawIdSubjectRolePolicy,
  openclawIdTunnelRolePolicy,
  onOpenClawIdTunnelPrincipalsChanged,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import {
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import {
  isOperatorRoleSourcePolicyCurrent,
  sourceRolePolicy,
} from "./operator-role-source-policy.js";
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
const continuationAuthorities = resolveGlobalSingleton(
  Symbol.for("openclaw.gatewayOperatorContinuationAuthorities"),
  () => new WeakMap<AdmittedRunOperatorAuthority, AdmittedRunOperatorAuthority>(),
);

/** Accepted continuations retain policy custody independently of a recovered work claim. */
export function bindGatewayOperatorContinuationAuthority(
  work: AdmittedRunOperatorAuthority,
  source: AdmittedRunOperatorAuthority,
): void {
  continuationAuthorities.set(work, source);
}

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

/** Keep the admission ceiling while refreshing only committed config/metadata views. */
function prepareRunModelPolicy(params: {
  cfg: OpenClawConfig;
  metadata: ReturnType<typeof getProcessGatewayPluginMetadataSnapshot>;
  initialPolicy: GatewayOperatorRoleDefinition["modelPolicy"];
  getConfig: () => OpenClawConfig;
  resolvePolicy: (cfg: OpenClawConfig) => GatewayOperatorRoleDefinition["modelPolicy"];
}) {
  let { cfg, metadata } = params;
  let publication = runtimeConfigPublication.current?.revision;
  const original = prepareOperatorModelPolicy({
    cfg,
    policy: params.initialPolicy,
    manifestPlugins: metadata ?? [],
  });
  let policy = original;
  return {
    original,
    readCurrent: () => {
      const nextConfig = params.getConfig();
      const nextMetadata = getProcessGatewayPluginMetadataSnapshot();
      const nextPublication = runtimeConfigPublication.current?.revision;
      if (nextConfig !== cfg || nextMetadata !== metadata || nextPublication !== publication) {
        const current = prepareOperatorModelPolicy({
          cfg: nextConfig,
          policy: params.resolvePolicy(nextConfig),
          manifestPlugins: nextMetadata ?? [],
        });
        policy = intersectOperatorRunModelPolicy(original, current);
        cfg = nextConfig;
        metadata = nextMetadata;
        publication = nextPublication;
      }
      return policy;
    },
  };
}

/** Bridge a prepared linked principal while retaining its exact channel admission capability. */
export function captureChannelOperatorRunAuthority(input: {
  profileId: string;
  recoveryReference?: UserChannelAuthorizationReference;
  openclawIdPrincipal?: OpenClawIdTunnelPrincipal;
  assignedRole: string | null;
  githubLogin?: string | null;
  scopes: readonly string[];
  gatewayAccessGrant: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
  getRuntimeConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  signal?: AbortSignal;
}): AdmittedRunOperatorAuthority {
  const params = { ...input };
  params.assertCurrent();
  const initialConfig = params.getRuntimeConfig();
  const metadata = getProcessGatewayPluginMetadataSnapshot();
  const membershipPolicy = openclawIdTunnelRolePolicy(params.openclawIdPrincipal);
  const resolveRole = (cfg: OpenClawConfig) =>
    openclawIdSubjectRolePolicy(params.openclawIdPrincipal, () =>
      resolveOperatorRolePolicyForAssignment(
        params.profileId,
        params.assignedRole,
        cfg,
        params.githubLogin ?? null,
      ),
    );
  const role = resolveRole(initialConfig);
  const modelPolicy = prepareRunModelPolicy({
    cfg: initialConfig,
    metadata,
    initialPolicy: role?.modelPolicy,
    getConfig: params.getRuntimeConfig,
    resolvePolicy: (cfg) => resolveRole(cfg)?.modelPolicy,
  });
  const revocation = createChannelOperatorRevocation(params);
  return createAdmittedRunOperatorAuthority({
    profileId: params.profileId,
    openclawIdPrincipal: params.openclawIdPrincipal,
    channelRecoverySource: params.recoveryReference
      ? { reference: params.recoveryReference, modelPolicy: modelPolicy.original }
      : undefined,
    scopes: params.scopes,
    rolePolicy: prepareRunRolePolicy(sourceRolePolicy(role)),
    gatewayAccessGrant: params.gatewayAccessGrant,
    assertCurrent: revocation.assertCurrent,
    signal: revocation.signal,
    retain: revocation.retain,
    readCurrentRoleFacts: () => ({
      assignedRole: params.assignedRole,
      githubLogin: params.githubLogin ?? null,
      ...(membershipPolicy ? { policy: membershipPolicy } : {}),
    }),
    get modelPolicy() {
      return modelPolicy.readCurrent();
    },
    onModelPolicyChanged: (listener) => {
      const releaseProfile = onUserProfilesChanged(listener);
      const releasePolicy = onOperatorRolePolicyChanged((change) => {
        if (change.kind === "config" || change.profileId === params.profileId) {
          listener();
        }
      });
      // Recheck through the channel assertion so cancellation keeps its revocation error.
      const signals = [params.signal, revocation.signal];
      for (const signal of signals) {
        signal?.addEventListener("abort", listener, { once: true });
      }
      return () => {
        releaseProfile();
        releasePolicy();
        for (const signal of signals) {
          signal?.removeEventListener("abort", listener);
        }
      };
    },
  });
}

/** Transfers the original operator restriction into accepted work, independently of its request. */
export async function captureGatewayOperatorRunAuthority(input: {
  client: GatewayClient | null;
  context: Pick<
    GatewayRequestContext,
    "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
  >;
  hasCurrentClientAuthority?: () => boolean;
  /** Only an accepting work owner may outlive the original scheduling claim. */
  independentContinuation?: true;
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
}): Promise<{ authority: AdmittedRunOperatorAuthority; release: () => void } | undefined> {
  const params = { ...input };
  const inherited = params.client?.internal?.operatorRunAuthority;
  if (inherited !== undefined) {
    assertAdmittedRunOperatorAuthority(inherited);
    inherited.assertCurrent();
    const scopes = intersectOperatorScopes(inherited.scopes, params.client?.connect.scopes ?? []);
    const continuation = continuationAuthorities.get(inherited);
    const source = params.independentContinuation ? (continuation ?? inherited) : inherited;
    const authority = roleScopesAllow({
      role: "operator",
      requestedScopes: source.scopes,
      allowedScopes: scopes,
    })
      ? source
      : createAdmittedRunOperatorAuthority({
          ...source,
          scopes,
          get modelPolicy() {
            return source.modelPolicy;
          },
        });
    if (continuation && !params.independentContinuation && authority !== inherited) {
      continuationAuthorities.set(authority, continuation);
    }
    return { authority, release: source.retain?.() ?? (() => {}) };
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
  const membershipPolicy = openclawIdTunnelRolePolicy(openclawIdPrincipal);
  const profileId =
    actor?.kind === "operator"
      ? actor.profileId
      : isLinkedOwnerDevice(actor) && client.authenticatedUserProfile
        ? client.authenticatedUserProfile.profileId
        : GATEWAY_OWNER_PROFILE_ID;
  const connectionId = client.connId;
  const connectionSignal = client.connectionSignal;
  if (params.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway caller authority is no longer active.");
  }
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
  const sourceAuthorities = [sourceAuthority, ingressPrincipal, params.invocationAuthority];
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
  let revoked = false;
  const revocation = new AbortController();
  const subscriptions: Array<(() => void) | undefined> = [];
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
  const resolveCurrentRole = (cfg = getConfig()) => {
    const profile = assertProfileCurrent();
    return openclawIdSubjectRolePolicy(openclawIdPrincipal, () =>
      resolveOperatorRolePolicyForAssignment(
        profileId,
        profile.assignedRole,
        cfg,
        profile.githubLogin ?? null,
      ),
    );
  };
  const assertRoleCurrent = () => {
    const policy = resolveCurrentRole();
    // Role grants are exact config enum values, unlike signed connection scopes.
    if (policy && resolveMissingOperatorScope(scopes, policy.scopes) !== null) {
      throw new Error("Your operator role changed; reconnect before continuing.");
    }
  };
  const revoke = (reason: unknown) => {
    if (references > 0 && isGatewayCurrent()) {
      revoked = true;
      revocation.abort(reason);
    }
  };
  const recheck = (check: () => void) => {
    if (!revoked && references > 0 && isGatewayCurrent()) {
      try {
        check();
      } catch (error) {
        revoke(error);
      }
    }
  };
  const assertSourceCurrent = composeSessionSourceAssertion(
    sourceAuthorities.map((authority) =>
      composeSessionSourceAssertion([authority?.assertCurrent], (assertSource) => {
        authority?.signal?.throwIfAborted();
        assertSource();
        authority?.signal?.throwIfAborted();
      }),
    ),
    (assertSources) => {
      if (revoked || references === 0) {
        throw createOperatorAuthorityInactiveError(
          references === 0 ? "closure-released" : "closure-revoked",
          "before-sources",
          capturedAt,
        );
      }
      if (isSourceCurrent?.() === false) {
        throw createOperatorAuthorityInactiveError(
          "source-invalidated",
          "source-current",
          capturedAt,
        );
      }
      if (!isGatewayCurrent()) {
        throw createOperatorAuthorityInactiveError(
          "gateway-identity-retired",
          "gateway-current",
          capturedAt,
        );
      }
      assertSources();
      if (openclawIdPrincipal && !isOpenClawIdTunnelPrincipalCurrent(openclawIdPrincipal)) {
        throw new Error("OpenClaw ID membership authority changed");
      }
      if (revoked || references === 0) {
        throw createOperatorAuthorityInactiveError(
          references === 0 ? "closure-released" : "closure-revoked",
          "after-sources",
          capturedAt,
        );
      }
    },
  );
  const assertCurrent = composeSessionSourceAssertion([assertSourceCurrent], (assertSource) => {
    try {
      assertSource();
      assertRoleCurrent();
    } catch (error) {
      revoked = true;
      throw error;
    }
  });
  const releaseHold = () => {
    let released = false;
    return () => {
      if (!released) {
        released = true;
        if (--references === 0) {
          releaseSource?.();
          releaseSource = undefined;
          for (const unsubscribe of subscriptions.splice(0)) {
            unsubscribe?.();
          }
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
  try {
    let assertCapturedRoleCurrent = () => {
      // Capture current policy after preparation; reverted changes need no replay.
    };
    subscriptions.push(
      onGatewayDeviceSourceRevoked(params.hasCurrentClientAuthority, () =>
        revoke(
          createOperatorAuthorityInactiveError(
            "source-invalidated",
            "source-revocation",
            capturedAt,
          ),
        ),
      ),
      onUserProfilesChanged(() => recheck(assertCapturedRoleCurrent)),
      openclawIdPrincipal
        ? onOpenClawIdTunnelPrincipalsChanged(() => recheck(assertSourceCurrent))
        : undefined,
      onOperatorRolePolicyChanged((change) => {
        if (
          change.kind === "assignment" &&
          change.profileId === profileId &&
          change.roleOnly &&
          openclawIdPrincipal?.kind === "owner"
        ) {
          // A linked owner device's authority is its certificate; its person's role is not.
          recheck(assertCapturedRoleCurrent);
        } else if (change.kind === "assignment" && change.profileId === profileId) {
          revoke(new Error("Your operator role changed; reconnect before continuing."));
        } else if (
          change.kind === "config" &&
          change.context === (gatewayContext ?? params.context)
        ) {
          recheck(assertCapturedRoleCurrent);
        }
      }),
    );
    for (const authority of sourceAuthorities) {
      const sourceSignal = authority?.signal;
      if (sourceSignal) {
        const onAbort = () => revoke(sourceSignal.reason);
        sourceSignal.addEventListener("abort", onAbort, { once: true });
        subscriptions.push(() => sourceSignal.removeEventListener("abort", onAbort));
      }
    }
    assertSourceCurrent();
    preparedProfile = await prepareUserProfileIdentity(profileId);
    const currentActor = resolveGatewayOperatorRoleActor(params.client);
    const originalActorCurrent = authenticatedOwner
      ? isAuthenticatedOwner(currentActor) &&
        client.connId === connectionId &&
        client.connectionSignal === connectionSignal
      : currentActor?.kind === "operator" && currentActor.profileId === profileId;
    if (
      params.client !== client ||
      !originalActorCurrent ||
      params.hasCurrentClientAuthority?.() === false ||
      !isGatewayCurrent() ||
      !roleScopesAllow({
        role: "operator",
        requestedScopes: scopes,
        allowedScopes: client.connect.scopes ?? [],
      })
    ) {
      throw new Error("Gateway caller authority is no longer active.");
    }
    const capturedConfig = getConfig();
    const capturedProfile = assertProfileCurrent();
    const capturedAssignedRole = capturedProfile.assignedRole;
    const capturedRole = structuredClone(resolveCurrentRole(capturedConfig));
    const capturedSourcePolicy = sourceRolePolicy(capturedRole);
    assertCapturedRoleCurrent = () => {
      const current = assertProfileCurrent();
      const policy = resolveCurrentRole();
      // A current owner certificate, not the linked person's stored role, bounds owner work.
      const ownerCertificate =
        openclawIdPrincipal?.kind === "owner" &&
        isOpenClawIdTunnelPrincipalCurrent(openclawIdPrincipal);
      if (
        (!ownerCertificate && current.assignedRole !== capturedAssignedRole) ||
        !isOperatorRoleSourcePolicyCurrent(capturedSourcePolicy, sourceRolePolicy(policy), scopes)
      ) {
        throw new Error("Your operator role changed; reconnect before continuing.");
      }
    };
    const modelPolicy = prepareRunModelPolicy({
      cfg: capturedConfig,
      metadata: getProcessGatewayPluginMetadataSnapshot(),
      initialPolicy: capturedRole?.modelPolicy,
      getConfig,
      resolvePolicy: (cfg) => resolveCurrentRole(cfg)?.modelPolicy,
    });
    const source = retainOperatorSource(
      client,
      sourceOwners,
      readOperatorModelPolicyMembership(modelPolicy.original),
      params.hasCurrentClientAuthority,
    );
    releaseSource = source.release;
    const grant =
      sourceAuthority === null || (sourceAuthority === undefined && authenticatedOwner)
        ? null
        : sourceAuthority?.gatewayAccessGrant;
    // Pin the grant before source callbacks can mutate their original reference.
    const admission = {
      profileId,
      openclawIdPrincipal,
      scopes,
      gatewayAccessGrant: grant ? Object.freeze({ ...grant }) : grant,
      assertCurrent,
    };
    const recoverySnapshot = captureGatewayOperatorRecoverySnapshot({
      client,
      authority: admission,
      modelPolicy: modelPolicy.original,
      identity: preparedProfile,
      config: getConfig(),
    });
    assertCurrent();
    const authority = createAdmittedRunOperatorAuthority({
      ...admission,
      recoverySnapshot,
      rolePolicy: prepareRunRolePolicy(capturedSourcePolicy),
      readCurrentRoleFacts: () => ({
        ...assertProfileCurrent(),
        ...(membershipPolicy ? { policy: membershipPolicy } : {}),
      }),
      source: source.token,
      invocation: params.invocationAuthority,
      signal: revocation.signal,
      retain: () => {
        assertCurrent();
        references += 1;
        return releaseHold();
      },
      get modelPolicy() {
        return modelPolicy.readCurrent();
      },
      onModelPolicyChanged: (listener) =>
        onOperatorRolePolicyChanged((change) => {
          if (change.kind === "config" && change.context === (gatewayContext ?? params.context)) {
            listener();
          }
        }),
    });
    if (
      authenticatedOwner &&
      client.usesSharedGatewayAuth === true &&
      client.sharedGatewaySessionGeneration &&
      (isBrowserOperatorUiClient(client.connect.client) || isWebchatClient(client.connect.client))
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
