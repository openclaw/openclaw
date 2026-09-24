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
} from "../agents/operator-model-policy.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { intersectOperatorScopes, roleScopesAllow } from "../shared/operator-scope-compat.js";
import {
  onUserProfilesChanged,
  readUserProfileAliasRevision,
} from "../state/user-profile-events.js";
import { resolveUserProfileId } from "../state/user-profiles.js";
import {
  onGatewayDeviceSourceRevoked,
  readGatewayDeviceSourceAuthority,
  readGatewayDeviceSourceIdentity,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  authorizeSessionAgentRun,
  onOperatorRolePolicyChanged,
  resolveGatewayOperatorRoleActor,
  resolveOperatorRolePolicyForAssignment,
  resolveOperatorRolePolicyForProfile,
} from "./operator-role-policy.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
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
  isCurrent?: () => boolean;
  token: object;
  references: number;
};

// Comparison records live only while captured work retains their original authority.
const operatorSources = new WeakMap<object, Set<OperatorSource>>();

function retainOperatorSource(
  sourceOwner: object,
  owners: OperatorSource["owners"],
  membership: string | undefined,
  isCurrent?: () => boolean,
) {
  let sources = operatorSources.get(sourceOwner);
  if (!sources) {
    sources = new Set();
    operatorSources.set(sourceOwner, sources);
  }
  let source =
    membership === undefined
      ? undefined
      : [...sources].find(
          (entry) =>
            entry.membership === membership &&
            entry.isCurrent?.() !== false &&
            entry.owners.every((owner, index) => owner === owners[index]),
        );
  if (!source) {
    source = { owners, membership, isCurrent, token: Object.freeze({}), references: 0 };
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

type OperatorRunCaptureOptions = {
  context: Pick<
    GatewayRequestContext,
    "getRuntimeConfig" | "getCommittedRuntimeConfig" | "resolveGatewayContext"
  >;
  requesterChannelIdentity?: AdmittedRunOperatorAuthority["requesterChannelIdentity"];
  hasCurrentClientAuthority?: () => boolean;
  /** Prepared by the profile owner; avoids synchronous stores in resident projection callers. */
  preparedProfile?: Readonly<{
    profileId: string;
    role: string | null;
    isCurrent: () => boolean;
  }>;
  sourceAuthority?: Readonly<{
    assertCurrent: () => void;
    signal?: AbortSignal;
    gatewayAccessGrant?: AdmittedRunOperatorAuthority["gatewayAccessGrant"];
  }> | null;
  /** Additional request lifetime; never replaces the authenticated access grant. */
  invocationAuthority?: Readonly<{ assertCurrent: () => void; signal?: AbortSignal }>;
};

/** Transfers the original operator restriction into accepted work, independently of its request. */
export function captureGatewayOperatorRunAuthority(
  params: OperatorRunCaptureOptions & {
    client: GatewayClient | null;
  },
): { authority: AdmittedRunOperatorAuthority; release: () => void } | undefined {
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
  const authenticatedOwner =
    client?.internal?.authenticatedOperator === true &&
    (actor === undefined || actor.kind === "system") &&
    client.connect.role === "operator" &&
    Boolean(client.connId) &&
    !client.invalidated &&
    !client.connectionSignal?.aborted &&
    !client.internal.syntheticClient &&
    !client.internal.agentRuntimeIdentity &&
    !client.internal.agentToolCaller &&
    client.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID;
  if (!client || (actor?.kind !== "operator" && !authenticatedOwner)) {
    return undefined;
  }
  const profileId = actor?.kind === "operator" ? actor.profileId : GATEWAY_OWNER_PROFILE_ID;
  return captureOperatorRunAuthority({
    ...params,
    source: client,
    profileId,
    scopes: client.connect.scopes ?? [],
    sourceAuthority:
      params.sourceAuthority !== undefined
        ? params.sourceAuthority
        : client.internal?.operatorAccessAuthority,
  });
}

/** Browser and verified channel ingress share one person, policy, and execution lifetime. */
export function captureOperatorRunAuthority(
  params: OperatorRunCaptureOptions & {
    source: object;
    profileId: string;
    scopes: readonly string[];
  },
): { authority: AdmittedRunOperatorAuthority; release: () => void } {
  const { profileId } = params;
  const preparedProfile = params.preparedProfile;
  if (
    preparedProfile &&
    (preparedProfile.profileId !== profileId || !preparedProfile.isCurrent())
  ) {
    throw new Error("operator source identity changed; start a new request");
  }
  let aliasRevision = readUserProfileAliasRevision();
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
  const sourceAuthority = params.sourceAuthority;
  const sourceAuthorities = [sourceAuthority, params.invocationAuthority];
  const scopes = Object.freeze([...params.scopes]);
  let releaseSource: (() => void) | undefined;
  let references = 1;
  let revoked = false;
  const revocation = new AbortController();
  const subscriptions: Array<(() => void) | undefined> = [];
  const assertProfileCurrent = () => {
    if (preparedProfile) {
      if (!preparedProfile.isCurrent()) {
        throw new Error("operator source identity changed; start a new request");
      }
      return;
    }
    const currentAliasRevision = readUserProfileAliasRevision();
    if (currentAliasRevision !== aliasRevision) {
      if (resolveUserProfileId(profileId) !== profileId) {
        throw new Error("operator source identity changed; start a new request");
      }
      aliasRevision = currentAliasRevision;
    }
  };
  const assertRoleCurrent = () => {
    const policy = resolveRole();
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
        policy: resolveRole()?.modelPolicy,
        manifestPlugins: metadata ?? [],
      });
      modelPolicy =
        original &&
        current &&
        readOperatorModelPolicyMembership(original) !== readOperatorModelPolicyMembership(current)
          ? Object.freeze({
              models: Object.freeze(current.models.filter(original.allows)),
              allows: (ref: Parameters<typeof original.allows>[0]) =>
                original.allows(ref) && current.allows(ref),
            })
          : (current ?? original);
      modelPolicyConfig = cfg;
      modelPolicyMetadata = metadata;
    }
    return modelPolicy;
  };
  const revoke = (reason: unknown) => {
    if (references > 0) {
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
  const assertCurrent = () => {
    if (revoked || references === 0) {
      throw new Error("operator execution authority is no longer active");
    }
    try {
      if (isSourceCurrent?.() === false || !isGatewayCurrent()) {
        throw new Error("operator source authority is no longer active");
      }
      for (const authority of sourceAuthorities) {
        authority?.signal?.throwIfAborted();
        authority?.assertCurrent();
      }
      assertProfileCurrent();
      assertRoleCurrent();
    } catch (error) {
      revoke(error);
      throw error;
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
          for (const unsubscribe of subscriptions.splice(0)) {
            unsubscribe?.();
          }
          releaseDevice?.();
        }
      }
    };
  };
  const release = releaseHold();
  const resolveRole = () =>
    preparedProfile
      ? resolveOperatorRolePolicyForAssignment(profileId, preparedProfile.role, getConfig())
      : resolveOperatorRolePolicyForProfile(profileId, getConfig());
  try {
    const capturedRole = structuredClone(resolveRole());
    const capturedSourcePolicy = sourceRolePolicy(capturedRole);
    modelPolicy = prepareOperatorModelPolicy({
      cfg: modelPolicyConfig,
      policy: capturedRole?.modelPolicy,
      manifestPlugins: modelPolicyMetadata ?? [],
    });
    originalModelPolicy = modelPolicy;
    const source = retainOperatorSource(
      params.source,
      [
        gatewayContext ?? params.context,
        resolveGatewayContext,
        getConfig,
        readGatewayDeviceSourceIdentity(params.hasCurrentClientAuthority) ??
          (params.hasCurrentClientAuthority ? Object.freeze({}) : undefined),
        sourceAuthority,
        params.invocationAuthority,
      ],
      readOperatorModelPolicyMembership(originalModelPolicy),
      preparedProfile?.isCurrent,
    );
    releaseSource = source.release;
    subscriptions.push(
      onGatewayDeviceSourceRevoked(params.hasCurrentClientAuthority, () =>
        revoke(new Error("operator source authority is no longer active")),
      ),
      onOperatorRolePolicyChanged((change) => {
        if (change.kind === "assignment" && change.profileId === profileId) {
          revoke(new Error("Your operator role changed; reconnect before continuing."));
        } else if (
          change.kind === "config" &&
          change.context === (gatewayContext ?? params.context)
        ) {
          recheck(() => {
            const currentRole = resolveRole();
            if (!isDeepStrictEqual(capturedSourcePolicy, sourceRolePolicy(currentRole))) {
              throw new Error("Your operator role changed; reconnect before continuing.");
            }
          });
        }
      }),
      onUserProfilesChanged(() => recheck(assertProfileCurrent)),
    );
    for (const authority of sourceAuthorities) {
      const sourceSignal = authority?.signal;
      if (sourceSignal) {
        const onAbort = () => revoke(sourceSignal.reason);
        sourceSignal.addEventListener("abort", onAbort, { once: true });
        subscriptions.push(() => sourceSignal.removeEventListener("abort", onAbort));
      }
    }
    assertCurrent();
    return {
      authority: createAdmittedRunOperatorAuthority({
        profileId,
        scopes,
        requesterChannelIdentity: params.requesterChannelIdentity,
        gatewayAccessGrant: sourceAuthority === null ? null : sourceAuthority?.gatewayAccessGrant,
        source: source.token,
        assertCurrent,
        assertSessionAllowed: (target) => {
          assertCurrent();
          if (params.requesterChannelIdentity) {
            const admission = authorizeOperatorScopesForMethod("agent", scopes);
            if (!admission.allowed) {
              throw new Error(
                `Your operator role cannot start an agent run (requires ${admission.missingScope}); ask a Gateway administrator to update your role.`,
              );
            }
          }
          const error = authorizeSessionAgentRun(
            {
              cfg: getConfig(),
              client: null,
              target: {
                agentId: target.agentId,
                canonicalKey: target.sessionKey,
                entry: { sandbox: target.sandbox },
              },
            },
            { policy: resolveRole() },
          );
          if (error) {
            throw new Error(error.message);
          }
        },
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
