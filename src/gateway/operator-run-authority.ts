import { createHash } from "node:crypto";
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
  readOperatorModelPolicyCeilings,
  intersectOperatorModelPolicies,
} from "../agents/operator-model-policy.js";
import type { GoalRecoveryIssuerBasis } from "../config/sessions/main-session-recovery.types.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPublishedOperatorPairingIdentity } from "../infra/device-pairing-publication.js";
import { prepareOperatorPairingIdentity } from "../infra/device-pairing-store-readonly.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import { onUserProfilesChanged } from "../state/user-profile-events.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import {
  onGatewayDeviceSourceRevoked,
  readGatewayDeviceSourceAuthority,
  readGatewayDeviceSourceIdentity,
  readGatewayDeviceRecoverySource,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import { factoryGitHubDispatchCredentialReader } from "./factory-github-proof.js";
import {
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
} from "./operator-role-policy.js";
import {
  sourceRolePolicy,
  resolveOperatorRoleSourcePolicyGeneration,
} from "./operator-role-source-policy.js";
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
  let modelPolicyConfig = params.getRuntimeConfig();
  let modelPolicyMetadata = getProcessGatewayPluginMetadataSnapshot();
  const prepareModelPolicy = (cfg: OpenClawConfig, metadata: typeof modelPolicyMetadata) =>
    prepareOperatorModelPolicy({
      cfg,
      policy: resolveOperatorRolePolicyForAssignment(
        params.profileId,
        params.assignedRole,
        cfg,
        params.githubLogin ?? null,
      )?.modelPolicy,
      manifestPlugins: metadata ?? [],
    });
  const originalModelPolicy = prepareModelPolicy(modelPolicyConfig, modelPolicyMetadata);
  let modelPolicy = originalModelPolicy;
  return createAdmittedRunOperatorAuthority({
    profileId: params.profileId,
    scopes: params.scopes,
    rolePolicy: prepareRunRolePolicy(
      sourceRolePolicy(
        resolveOperatorRolePolicyForAssignment(
          params.profileId,
          params.assignedRole,
          modelPolicyConfig,
          params.githubLogin ?? null,
        ),
      ),
    ),
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
      const cfg = params.getRuntimeConfig();
      const metadata = getProcessGatewayPluginMetadataSnapshot();
      if (cfg !== modelPolicyConfig || metadata !== modelPolicyMetadata) {
        const current = prepareModelPolicy(cfg, metadata);
        modelPolicy = intersectOperatorModelPolicies(originalModelPolicy, current);
        modelPolicyConfig = cfg;
        modelPolicyMetadata = metadata;
      }
      return modelPolicy;
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
  const factoryActorId =
    process.env.FACTORY_AUTH_MODE === "github" &&
    client.internal?.authenticatedOperator === true &&
    !client.internal.syntheticClient &&
    !client.internal.agentRuntimeIdentity &&
    !client.internal.agentToolCaller &&
    Boolean(connectionId) &&
    !client.invalidated &&
    !connectionSignal?.aborted &&
    client.authenticatedUserProfile?.profileId === profileId
      ? client.authenticatedFactoryGitHubAccountId
      : undefined;
  if (params.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway caller authority is no longer active.");
  }
  const releaseDevice = retainGatewayDeviceRevocation(params.hasCurrentClientAuthority);
  const isSourceCurrent = readGatewayDeviceSourceAuthority(params.hasCurrentClientAuthority);
  const resolveGatewayContext = params.context.resolveGatewayContext;
  const gatewayContext = resolveGatewayContext?.();
  const getConfig = params.context.getCommittedRuntimeConfig ?? params.context.getRuntimeConfig;
  let modelPolicyConfig = getConfig();
  let modelPolicyMetadata = getProcessGatewayPluginMetadataSnapshot();
  let modelPolicy: ReturnType<typeof prepareOperatorModelPolicy>;
  let originalModelPolicy: ReturnType<typeof prepareOperatorModelPolicy>;
  const isGatewayCurrent = () =>
    !resolveGatewayContext ||
    (gatewayContext !== undefined && resolveGatewayContext() === gatewayContext);
  const sourceAuthority =
    params.sourceAuthority !== undefined
      ? params.sourceAuthority
      : client.internal?.operatorAccessAuthority;
  const sourceAuthorities = [sourceAuthority, params.invocationAuthority];
  const scopes = Object.freeze([...(client.connect.scopes ?? [])]);
  const capturedAuthPolicy = client.authPolicy;
  const authPrincipal: GoalRecoveryIssuerBasis["authPrincipal"] | undefined =
    capturedAuthPolicy && {
      role: capturedAuthPolicy.role,
      ...(capturedAuthPolicy.verifiedIdentity === undefined
        ? {}
        : { verifiedIdentity: capturedAuthPolicy.verifiedIdentity }),
      authMethod: capturedAuthPolicy.authMethod,
      ...(capturedAuthPolicy.authModeOverride === undefined
        ? {}
        : { authModeOverride: capturedAuthPolicy.authModeOverride }),
      ...(capturedAuthPolicy.browserOrigin === undefined
        ? {}
        : {
            browserOrigin: {
              ...(capturedAuthPolicy.browserOrigin.requestHost === undefined
                ? {}
                : { requestHost: capturedAuthPolicy.browserOrigin.requestHost }),
              ...(capturedAuthPolicy.browserOrigin.origin === undefined
                ? {}
                : { origin: capturedAuthPolicy.browserOrigin.origin }),
              ...(capturedAuthPolicy.browserOrigin.isLocalClient === undefined
                ? {}
                : { isLocalClient: capturedAuthPolicy.browserOrigin.isLocalClient }),
            },
          }),
    };
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
  const readModelPolicy = () => {
    const original = originalModelPolicy;
    const cfg = getConfig();
    const metadata = getProcessGatewayPluginMetadataSnapshot();
    if (cfg !== modelPolicyConfig || metadata !== modelPolicyMetadata) {
      const current = prepareOperatorModelPolicy({
        cfg,
        policy: resolveCurrentRole(cfg)?.modelPolicy,
        manifestPlugins: metadata ?? [],
      });
      modelPolicy = intersectOperatorModelPolicies(original, current);
      modelPolicyConfig = cfg;
      modelPolicyMetadata = metadata;
    }
    return modelPolicy;
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
    const initialRoleConfig = {
      gateway: { roles: structuredClone(modelPolicyConfig.gateway?.roles) },
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
    let capturedAliasBindingIds: readonly string[] | undefined;
    try {
      capturedAliasBindingIds = preparedProfile.emailBindingIds;
    } catch {
      // Legacy unattributed profiles cannot supply a durable continuation issuer.
    }
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
    originalModelPolicy = prepareOperatorModelPolicy({
      cfg: modelPolicyConfig,
      policy: resolveOperatorRolePolicyForAssignment(
        profileId,
        capturedAssignedRole,
        initialRoleConfig,
        capturedGithubLogin,
      )?.modelPolicy,
      manifestPlugins: modelPolicyMetadata ?? [],
    });
    modelPolicy = originalModelPolicy;
    const recoverySource = readGatewayDeviceRecoverySource(params.hasCurrentClientAuthority);
    if (
      process.env.FACTORY_AUTH_MODE === "github" &&
      factoryActorId &&
      recoverySource?.deviceId &&
      client.internal?.operatorPairingIdentity
    ) {
      // Fresh admission prepares the worker-owned publication; synchronous issuer
      // capture still checks this same live pairing before handing off authority.
      const pairingIdentity = await prepareOperatorPairingIdentity(recoverySource.deviceId);
      assertCurrent();
      if (pairingIdentity !== client.internal.operatorPairingIdentity) {
        throw new Error("Original operator pairing authority changed");
      }
    }
    preparationConfigs.length = 0;
    const source = retainOperatorSource(
      client,
      sourceOwners,
      readOperatorModelPolicyMembership(originalModelPolicy),
    );
    releaseSource = source.release;
    return {
      authority: createAdmittedRunOperatorAuthority({
        profileId,
        scopes,
        rolePolicy: prepareRunRolePolicy(capturedSourcePolicy),
        createFactoryGitHubDispatchCredentialReader: factoryActorId
          ? (target) => {
              const capturedTarget = { ...target };
              const assertFactoryCurrent = () => {
                assertCurrent();
                capturedTarget.assertCurrent();
                connectionSignal?.throwIfAborted();
                if (
                  client.connId !== connectionId ||
                  client.connectionSignal !== connectionSignal ||
                  client.authenticatedFactoryGitHubAccountId !== factoryActorId ||
                  client.authenticatedUserProfile?.profileId !== profileId ||
                  client.internal?.authenticatedOperator !== true
                ) {
                  throw new Error("Original Factory GitHub source changed");
                }
              };
              assertFactoryCurrent();
              const reader = factoryGitHubDispatchCredentialReader({
                ...capturedTarget,
                client,
                assertCurrent: assertFactoryCurrent,
              });
              if (!reader) {
                throw new Error("Original Factory GitHub source is unavailable");
              }
              return reader;
            }
          : undefined,
        captureRestartRecoveryIssuer: () => {
          assertCurrent();
          const dependency = readGatewayDeviceRecoverySource(params.hasCurrentClientAuthority);
          const pairingIdentity = client.internal?.operatorPairingIdentity;
          const ceilings = readOperatorModelPolicyCeilings(readModelPolicy());
          if (
            process.env.FACTORY_AUTH_MODE !== "github" ||
            !client.internal?.authenticatedOperator ||
            !factoryActorId ||
            client.authenticatedFactoryGitHubAccountId !== factoryActorId ||
            !dependency?.deviceId ||
            !dependency.authPolicyGeneration ||
            !authPrincipal ||
            authPrincipal.role !== "operator" ||
            !authPrincipal.authMethod ||
            capturedAuthPolicy?.grantGeneration !== dependency.authPolicyGeneration ||
            !pairingIdentity ||
            !capturedAliasBindingIds ||
            !ceilings ||
            sourceAuthority === undefined ||
            (sourceAuthority !== null && sourceAuthority.gatewayAccessGrant === undefined) ||
            (dependency.shared !== null && dependency.shared.generation === undefined)
          ) {
            return undefined;
          }
          const facts = preparedProfile!.readCurrentFacts(capturedAliasBindingIds);
          if (!facts.profile.emails.includes(`github:microsoft.ghe.com:${factoryActorId}`)) {
            throw new Error("Original Factory actor profile binding changed");
          }
          if (getPublishedOperatorPairingIdentity(dependency.deviceId) !== pairingIdentity) {
            throw new Error("Original operator pairing authority changed");
          }
          return {
            version: 1,
            profileId,
            factoryActor: { host: "microsoft.ghe.com", accountId: factoryActorId },
            assignedRole: capturedAssignedRole,
            rolePolicyGeneration: resolveOperatorRoleSourcePolicyGeneration(capturedRole),
            aliasBindingIds: [...capturedAliasBindingIds],
            scopes,
            modelCeilings: ceilings,
            device: { deviceId: dependency.deviceId, identity: pairingIdentity },
            authPrincipal: structuredClone(authPrincipal),
            authPolicyGeneration: createHash("sha256")
              .update(dependency.authPolicyGeneration)
              .digest("hex"),
            sharedAuthGeneration: dependency.shared?.generation ?? null,
            grant: sourceAuthority?.gatewayAccessGrant ?? null,
          };
        },
        readCurrentRoleAssignment: () => {
          assertCurrent();
          return assertProfileCurrent().assignedRole;
        },
        readCurrentGithubLogin: () => {
          assertCurrent();
          return assertProfileCurrent().githubLogin ?? null;
        },
        gatewayAccessGrant:
          sourceAuthority === null || (sourceAuthority === undefined && authenticatedOwner)
            ? null
            : sourceAuthority?.gatewayAccessGrant,
        source: source.token,
        assertCurrent,
        signal: revocation.signal,
        retain: () => {
          assertCurrent();
          references += 1;
          return releaseHold();
        },
        get modelPolicy() {
          return readModelPolicy();
        },
        onModelPolicyChanged: (listener) =>
          onOperatorRolePolicyChanged((change) => {
            if (change.kind === "config" && change.context === (gatewayContext ?? params.context)) {
              listener();
            }
          }),
      }),
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}

export {
  captureGatewayTurnIssuerAdmission,
  captureGatewayGoalIssuerAdmission,
} from "./operator-recovery-issuer-admission.js";
