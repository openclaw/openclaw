import { isDeepStrictEqual } from "node:util";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  assertAdmittedRunOperatorAuthority,
  createAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import {
  prepareOperatorModelPolicy,
  readOperatorModelPolicyMembership,
  type PreparedOperatorModelPolicy,
} from "../agents/operator-model-policy.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { capturePublishedOperatorDeviceSource } from "../infra/device-pairing-publication.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import {
  onGatewayDeviceSourceRevoked,
  readGatewayDeviceSourceAuthority,
  readGatewayDeviceSourceIdentity,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import {
  onOperatorRolePolicyChanged,
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
    invocation: object | undefined,
  ];
  membership: string | undefined;
  token: object;
  references: number;
};

// Comparison records live only while captured work retains their original authority.
const operatorSources = new WeakMap<GatewayClient, Set<OperatorSource>>();

function getOperatorSources(client: GatewayClient): Set<OperatorSource> {
  let sources = operatorSources.get(client);
  if (!sources) {
    sources = new Set();
    operatorSources.set(client, sources);
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
) {
  const sources = getOperatorSources(client);
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
      if (nextConfig !== cfg || nextMetadata !== metadata) {
        const current = prepareOperatorModelPolicy({
          cfg: nextConfig,
          policy: params.resolvePolicy(nextConfig),
          manifestPlugins: nextMetadata ?? [],
        });
        policy = intersectOperatorRunModelPolicy(original, current);
        cfg = nextConfig;
        metadata = nextMetadata;
      }
      return policy;
    },
  };
}

/** Bridge a prepared linked principal while retaining its exact channel admission capability. */
export function captureChannelOperatorRunAuthority(input: {
  profileId: string;
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
  const resolveRole = (cfg: OpenClawConfig) =>
    resolveOperatorRolePolicyForAssignment(
      params.profileId,
      params.assignedRole,
      cfg,
      params.githubLogin ?? null,
    );
  const role = resolveRole(initialConfig);
  const modelPolicy = prepareRunModelPolicy({
    cfg: initialConfig,
    metadata,
    initialPolicy: role?.modelPolicy,
    getConfig: params.getRuntimeConfig,
    resolvePolicy: (cfg) => resolveRole(cfg)?.modelPolicy,
  });
  return createAdmittedRunOperatorAuthority({
    profileId: params.profileId,
    scopes: params.scopes,
    rolePolicy: prepareRunRolePolicy(sourceRolePolicy(role)),
    gatewayAccessGrant: params.gatewayAccessGrant,
    assertCurrent: params.assertCurrent,
    readCurrentRoleAssignment: () => {
      params.assertCurrent();
      return params.assignedRole;
    },
    readCurrentGithubLogin: () => {
      params.assertCurrent();
      return params.githubLogin ?? null;
    },
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
      params.signal?.addEventListener("abort", listener, { once: true });
      return () => {
        releaseProfile();
        releasePolicy();
        params.signal?.removeEventListener("abort", listener);
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
  sourceAuthority?: Readonly<{
    assertCurrent: () => void;
    signal?: AbortSignal;
    gatewayAccessGrant?: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
  }> | null;
  /** Additional request lifetime; never replaces the authenticated access grant. */
  invocationAuthority?: Readonly<{ assertCurrent: () => void; signal?: AbortSignal }>;
}): Promise<{ authority: AdmittedRunOperatorAuthority; release: () => void } | undefined> {
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
    return { authority, release: inherited.retain?.() ?? (() => {}) };
  }
  const actor = resolveGatewayOperatorRoleActor(params.client);
  const client = params.client;
  // Shared-secret owner sessions keep system role semantics, but still have an
  // authenticated user subject. Capture only the real, handshake-attested ingress:
  // an autonomous/synthetic system caller must not acquire the owner profile.
  const isAuthenticatedOwner = (currentActor: typeof actor) =>
    client?.internal?.authenticatedOperator === true &&
    (currentActor === undefined || currentActor.kind === "system") &&
    client.connect.role === "operator" &&
    Boolean(client.connId) &&
    !client.invalidated &&
    !client.connectionSignal?.aborted &&
    !client.internal.syntheticClient &&
    !client.internal.agentRuntimeIdentity &&
    !client.internal.agentToolCaller &&
    client.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID;
  const authenticatedOwner = isAuthenticatedOwner(actor);
  if (!client || (actor?.kind !== "operator" && !authenticatedOwner)) {
    return undefined;
  }
  const profileId = actor?.kind === "operator" ? actor.profileId : GATEWAY_OWNER_PROFILE_ID;
  const connectionId = client.connId;
  const connectionSignal = client.connectionSignal;
  if (params.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway caller authority is no longer active.");
  }
  const releaseDevice = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const isSourceCurrent = readGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority);
  const resolveGatewayContext = params.context.resolveGatewayContext;
  const gatewayContext = resolveGatewayContext?.();
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  const initialModelConfig = getConfig();
  const initialModelMetadata = getProcessGatewayPluginMetadataSnapshot();
  const isGatewayCurrent = () =>
    !resolveGatewayContext ||
    (gatewayContext !== undefined && resolveGatewayContext() === gatewayContext);
  const sourceAuthority =
    params.sourceAuthority !== undefined
      ? params.sourceAuthority
      : client.internal?.operatorAccessAuthority;
  const sourceAuthorities = [sourceAuthority, params.invocationAuthority];
  const scopes = Object.freeze([...(client.connect.scopes ?? [])]);
  const sourceOwners: OperatorSource["owners"] = [
    gatewayContext ?? params.context,
    resolveGatewayContext,
    getConfig,
    readGatewayDeviceSourceIdentity(params.hasCurrentClientAuthority) ??
      (params.hasCurrentClientAuthority ? Object.freeze({}) : undefined),
    sourceAuthority,
    params.invocationAuthority,
  ];
  let releaseSource: (() => void) | undefined;
  let references = 1;
  let revoked = false;
  const revocation = new AbortController();
  const subscriptions: Array<(() => void) | undefined> = [];
  let preparedProfile: Awaited<ReturnType<typeof prepareUserProfileIdentity>> | undefined;
  let pairingSource: ReturnType<typeof capturePublishedOperatorDeviceSource> | undefined;
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
    return resolveOperatorRolePolicyForAssignment(
      profileId,
      profile.assignedRole,
      cfg,
      profile.githubLogin ?? null,
    );
  };
  const assertRoleCurrent = () => {
    const policy = resolveCurrentRole();
    if (
      policy &&
      !roleScopesAllow({ role: "operator", requestedScopes: scopes, allowedScopes: policy.scopes })
    ) {
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
        throw new Error("operator execution authority is no longer active");
      }
      if (isSourceCurrent?.() === false || !isGatewayCurrent()) {
        throw new Error("operator source authority is no longer active");
      }
      assertSources();
      pairingSource?.assertCurrent();
      if (revoked || references === 0) {
        throw new Error("operator execution authority is no longer active");
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
          releaseDevice?.();
        }
      }
    };
  };
  const release = releaseHold();
  try {
    const pairedIdentity = client.internal?.operatorDeviceTokenIdentity;
    if (pairedIdentity) {
      pairingSource = capturePublishedOperatorDeviceSource(pairedIdentity, scopes, () =>
        revoke(new Error("operator device pairing changed; reconnect before continuing")),
      );
      subscriptions.push(pairingSource.release);
    }
    const initialRoleConfig = {
      gateway: { roles: structuredClone(initialModelConfig.gateway?.roles) },
    };
    const preparationConfigs = [initialRoleConfig];
    let onConfigChange = () => {
      preparationConfigs.push({ gateway: { roles: structuredClone(getConfig().gateway?.roles) } });
    };
    let profileChangedDuringPreparation = false;
    let onProfileChange = () => {
      profileChangedDuringPreparation = true;
    };
    // The assignment arrives asynchronously. Keep committed policy changes until
    // it can be resolved, so revocation cannot disappear behind a later restore.
    subscriptions.push(
      onGatewayDeviceSourceRevoked(params.hasCurrentClientAuthority, () =>
        revoke(new Error("operator source authority is no longer active")),
      ),
      onUserProfilesChanged(() => onProfileChange()),
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === profileId) {
          revoke(new Error("Your operator role changed; reconnect before continuing."));
        } else if (
          change.kind === "config" &&
          change.context === (gatewayContext ?? params.context)
        ) {
          onConfigChange();
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
    const capturedProfile = assertProfileCurrent();
    const capturedAssignedRole = capturedProfile.assignedRole;
    const capturedGithubLogin = capturedProfile.githubLogin ?? null;
    const capturedRole = structuredClone(resolveCurrentRole());
    const capturedSourcePolicy = sourceRolePolicy(capturedRole);
    if (
      preparationConfigs.some(
        (config) =>
          !isDeepStrictEqual(
            capturedSourcePolicy,
            sourceRolePolicy(
              resolveOperatorRolePolicyForAssignment(
                profileId,
                capturedAssignedRole,
                config,
                capturedGithubLogin,
              ),
            ),
          ),
      )
    ) {
      revoke(new Error("Your operator role changed; reconnect before continuing."));
    }
    const assertCapturedRoleCurrent = () => {
      const current = assertProfileCurrent();
      const policy = resolveOperatorRolePolicyForAssignment(
        profileId,
        current.assignedRole,
        getConfig(),
        current.githubLogin ?? null,
      );
      if (
        current.assignedRole !== capturedAssignedRole ||
        !isDeepStrictEqual(capturedSourcePolicy, sourceRolePolicy(policy))
      ) {
        throw new Error("Your operator role changed; reconnect before continuing.");
      }
    };
    onConfigChange = () => recheck(assertCapturedRoleCurrent);
    onProfileChange = () => recheck(assertCapturedRoleCurrent);
    if (profileChangedDuringPreparation) {
      onProfileChange();
    }
    assertCurrent();
    const modelPolicy = prepareRunModelPolicy({
      cfg: initialModelConfig,
      metadata: initialModelMetadata,
      initialPolicy: resolveOperatorRolePolicyForAssignment(
        profileId,
        capturedAssignedRole,
        initialRoleConfig,
        capturedGithubLogin,
      )?.modelPolicy,
      getConfig,
      resolvePolicy: (cfg) => resolveCurrentRole(cfg)?.modelPolicy,
    });
    preparationConfigs.length = 0;
    const source = retainOperatorSource(
      client,
      sourceOwners,
      readOperatorModelPolicyMembership(modelPolicy.original),
    );
    releaseSource = source.release;
    const grant =
      sourceAuthority === null || (sourceAuthority === undefined && authenticatedOwner)
        ? null
        : sourceAuthority?.gatewayAccessGrant;
    // Pin the grant before source callbacks can mutate their original reference.
    const admission = {
      profileId,
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
      readCurrentRoleAssignment: () => {
        assertCurrent();
        return assertProfileCurrent().assignedRole;
      },
      readCurrentGithubLogin: () => {
        assertCurrent();
        return assertProfileCurrent().githubLogin ?? null;
      },
      source: source.token,
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
    return { authority, release };
  } catch (error) {
    release();
    throw error;
  }
}
